from flask import Flask, request, Response, jsonify, stream_with_context
import cloudscraper
import requests
import os
import logging,traceback
from urllib.parse import urlencode,unquote, urlparse

# 配置更详细的日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

app = Flask(__name__)

# 关闭 ASCII 转义，确保中文正常显示
app.json.ensure_ascii = False

# 创建 cloudscraper 会话（自动处理 Cloudflare 挑战）
scraper = cloudscraper.create_scraper()

# 全局错误处理
@app.errorhandler(500)
def internal_server_error(error):
    logger.error(f"服务器内部错误: {str(error)}")
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
    if request.headers.get("Authorization"):
        headers["Authorization"] = request.headers.get("Authorization")
    if request.headers.get("X-Version"):
        headers["X-Version"] = request.headers.get("X-Version")
    
    return headers

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
        target_url = f"https://api.iwara.tv{request.full_path}"
        
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
    """文件反代 - 直接访问 files.iwara.tv"""
    try:
        target_url = f"https://files.iwara.tv{request.full_path}"
        
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