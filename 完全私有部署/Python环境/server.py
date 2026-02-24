from flask import Flask, request, Response, jsonify, stream_with_context
import cloudscraper
import requests
import os
import logging,traceback
import base64
import hmac
from urllib.parse import urlencode,unquote, urlparse

# 配置更详细的日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

app = Flask(__name__)

BASIC_AUTH_USER = os.environ.get('BASIC_AUTH_USER', '')
BASIC_AUTH_PASS = os.environ.get('BASIC_AUTH_PASS', '')
IWARA_AUTHORIZATION = os.environ.get('IWARA_AUTHORIZATION', '')
BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS = 86400

# 关闭 ASCII 转义，确保中文正常显示
app.json.ensure_ascii = False

# 创建 cloudscraper 会话（自动处理 Cloudflare 挑战）
scraper = cloudscraper.create_scraper()


def _auth_required_response():
    resp = Response("Authentication required", 401)
    resp.headers["WWW-Authenticate"] = 'Basic realm="IwaraProxy", charset="UTF-8"'
    return resp


def _safe_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a or "", b or "")


def _normalize_iwara_authorization(value: str) -> str:
    v = (value or "").strip()
    if not v:
        return ""
    return v if v.lower().startswith("bearer ") else ("Bearer " + v)

def _resolve_upstream_authorization() -> str:
    customized = (request.headers.get("CustomizedToken") or "").strip()
    if customized:
        return _normalize_iwara_authorization(customized)
    return _normalize_iwara_authorization(IWARA_AUTHORIZATION or "")


@app.before_request
def require_basic_auth():
    enabled = bool(BASIC_AUTH_USER or BASIC_AUTH_PASS)
    if not enabled:
        return None

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Basic "):
        return _auth_required_response()

    try:
        decoded = base64.b64decode(auth[6:]).decode("utf-8")
    except Exception:
        return _auth_required_response()

    user, sep, passwd = decoded.partition(":")
    if not sep:
        passwd = ""

    if not (_safe_eq(user, BASIC_AUTH_USER) and _safe_eq(passwd, BASIC_AUTH_PASS)):
        return _auth_required_response()
    return None
def _decode_jwt_payload(token: str):
    try:
        raw = (token or "").strip()
        if raw.lower().startswith("bearer "):
            raw = raw[7:].strip()
        if not raw:
            return None
        parts = raw.split(".")
        if len(parts) != 3:
            return None
        payload_b64 = parts[1]
        padding = '=' * (-len(payload_b64) % 4)
        decoded = base64.urlsafe_b64decode((payload_b64 + padding).encode("utf-8")).decode("utf-8")
        import json
        return json.loads(decoded)
    except Exception:
        return None


def _get_backend_token_status() -> str:
    token = _normalize_iwara_authorization(IWARA_AUTHORIZATION or "")
    if not token:
        return "not_configured"
    payload = _decode_jwt_payload(token)
    if not payload or not isinstance(payload.get("exp"), (int, float)):
        return "expired"
    import time
    return "valid" if payload.get("exp", 0) > int(time.time()) else "expired"
# 全局错误处理
@app.errorhandler(500)
def internal_server_error(error):
    logger.error(f"服务器内部错误:  {str(error)}")
    logger.error(traceback.format_exc())
    return jsonify({"error": "内部服务器错误", "message": str(error)}), 500

@app.errorhandler(404)
def not_found_error(error):
    return jsonify({"error": "路由不存在"}), 404

@app.errorhandler(Exception)
def handle_exception(error):
    logger.error(f"未捕获的异常: {str(error)}")
    logger.error(traceback.format_exc())
    return jsonify({"error": "服务器异常"}), 500

# 读取 index.html
index_html = ""
try:
    with open("./index.html", "r", encoding="utf-8") as f:
        index_html = f.read()
except FileNotFoundError:
    index_html = "<h1>Loading...</h1>"

def filter_headers():
   """过滤和构造请求头"""
    headers = {
        "User-Agent": request.headers.get("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
        "Accept": request.headers.get("Accept", "*/*"),
    }
    
    # 透传相关头信息
    if request.headers.get("Range"):
        headers["Range"] = request.headers.get("Range")
    if request.headers.get("Referer"):
        headers["Referer"] = request.headers.get("Referer")
    if request.headers.get("Origin"):
        headers["Origin"] = request.headers.get("Origin")
    upstream_authorization = _resolve_upstream_authorization()
    if upstream_authorization:
        headers["Authorization"] = upstream_authorization
    if request.headers.get("X-Version"):
        headers["X-Version"] = request.headers.get("X-Version")
    
    return headers

@app.route('/token-status', methods=['GET'])
def token_status():
    status = _get_backend_token_status()
    if status == "not_configured":
        resp = Response(status=204)
        resp.headers["Retry-After"] = str(BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS)
        return resp
    if status == "valid":
        return Response(status=204)
    return jsonify({"code": "backend_token_expired", "message": "后端设置的token已过期！"}), 200
@app.route('/')
def index():
     """首页"""
    return index_html, 200, {'content-type': 'text/html; charset=utf-8'}

"""判断反代域名是否为iwara"""
def is_iwara_url(encoded_url: str) -> bool:
    decoded = unquote(encoded_url)
    parsed = urlparse(decoded)
    return parsed.scheme in ("http", "https") and parsed.hostname and parsed.hostname.endswith(".iwara.tv")

@app.route('/video/<path:subpath>',methods=['GET'])
@app.route('/videos',methods=['GET'])
def video_proxy(subpath=''):
    """视频 API 反代"""
    try:
        target_url = f"https://apiq.iwara.tv{request.full_path}"
        
        logger.info(f"反代请求：{target_url}")
        
        headers = filter_headers()
        response = scraper.get(target_url, headers=headers, timeout=15)
        
        # 根据内容类型处理响应
        content_type = response.headers.get('content-type', '')
        
        if 'application/json' in content_type:
            return jsonify(response.json()), response.status_code
        else:
            return Response(response.text, status=response.status_code, content_type=content_type)
            
    except Exception as err:
        logger.error(f"反代出错：{err}")
        return jsonify({"error": str(err)}), 500

@app.route('/file/<path:subpath>',methods=['GET'])
def file_proxy(subpath=''):
     """文件反代 - 直接访问 filesq.iwara.tv"""
    try:
        target_url = f"https://filesq.iwara.tv{request.full_path}"
        
        logger.info(f"反代请求：{target_url}")
        
        headers = filter_headers()
        response = scraper.get(target_url, headers=headers, timeout=15)
        
        content_type = response.headers.get('content-type', '')
        
        if 'application/json' in content_type:
            return jsonify(response.json()), response.status_code
        else:
            return Response(response.text, status=response.status_code, content_type=content_type)
            
    except Exception as err:
        logger.error(f"反代出错：{err}")
        return jsonify({"error": str(err)}), 500

@app.route('/view',methods=['GET'])
def video_stream():
      """视频文件流式反代（支持 Range）"""
    try:
        video_url = request.args.get('url')
        if not video_url:
            return jsonify({"error": "缺少url参数值！"}), 400
        if not is_iwara_url(video_url):
            return jsonify({"error": "禁止滥用反代其他域名！"}), 403
        
        headers = filter_headers()
        
        # 使用 stream=True 进行流式传输
        response = scraper.get(video_url, headers=headers, stream=True, timeout=15)
        
        def generate():
            for chunk in response.iter_content(chunk_size=8192):
                yield chunk
        
        # 复制响应头
        response_headers = dict(response.headers)
        
        # 移除一些不必要的头
        for header in ['Content-Encoding', 'Transfer-Encoding', 'Connection']:
            response_headers.pop(header, None)
        
        return Response(
            stream_with_context(generate()),
            status=response.status_code,
            headers=response_headers,
            content_type=response.headers.get('content-type')
        )
        
    except Exception as err:
        logger.error(f"视频代理出错：{err}")
        return jsonify({"error": str(err)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port, threaded=True)






