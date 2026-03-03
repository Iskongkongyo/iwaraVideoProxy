from flask import Flask, request, Response, jsonify, stream_with_context
import cloudscraper
import os
import logging
import traceback
import base64
import hmac
import json
import time
import re
from urllib.parse import unquote, urlparse

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# 如果你设置了默认Iwara账号的Token，那么我强烈建议你设置访问的用户名和密码进一步保证你的账号隐私安全（虽然项目有做保护）！！！
BASIC_AUTH_USER = os.environ.get('BASIC_AUTH_USER', '') # 设置访问的用户名
BASIC_AUTH_PASS = os.environ.get('BASIC_AUTH_PASS', '') # 设置访问的密码
IWARA_AUTHORIZATION = os.environ.get('IWARA_AUTHORIZATION', '') # 设置默认使用Iwara账号的Token
BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS = 86400 # 前端请求检测后端Token有效期间隔(单位秒，默认1天，后端未设置token生效)

# Keep Chinese JSON readable
app.json.ensure_ascii = False

scraper = cloudscraper.create_scraper()


def _auth_required_response():
    resp = Response('Authentication required', 401)
    resp.headers['WWW-Authenticate'] = 'Basic realm="IwaraProxy", charset="UTF-8"'
    return resp


def _safe_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a or '', b or '')


def _normalize_iwara_authorization(value: str) -> str:
    v = (value or '').strip()
    if not v:
        return ''
    return v if v.lower().startswith('bearer ') else ('Bearer ' + v)


def _resolve_upstream_authorization() -> str:
    customized = (request.headers.get('CustomizedToken') or '').strip()
    if customized:
        return _normalize_iwara_authorization(customized)
    return _normalize_iwara_authorization(IWARA_AUTHORIZATION or '')


@app.before_request
def require_basic_auth():
    enabled = bool(BASIC_AUTH_USER or BASIC_AUTH_PASS)
    if not enabled:
        return None

    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Basic '):
        return _auth_required_response()

    try:
        decoded = base64.b64decode(auth[6:]).decode('utf-8')
    except Exception:
        return _auth_required_response()

    user, sep, passwd = decoded.partition(':')
    if not sep:
        passwd = ''

    if not (_safe_eq(user, BASIC_AUTH_USER) and _safe_eq(passwd, BASIC_AUTH_PASS)):
        return _auth_required_response()
    return None


@app.before_request
def restrict_proxy_methods():
    path = request.path or ''
    is_proxy_path = (
        path.startswith('/video/')
        or path == '/videos'
        or path.startswith('/file/')
        or path == '/view'
    )
    if not is_proxy_path:
        return None

    method = (request.method or '').upper()
    if method == 'OPTIONS':
        resp = Response(status=204)
        resp.headers['Allow'] = 'GET, OPTIONS'
        resp.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, CustomizedToken, X-Version, X-Site, Range'
        return resp

    if method != 'GET':
        return jsonify({'error': '仅允许代理GET和OPTIONS请求'}), 403

    return None


def _decode_jwt_payload(token: str):
    try:
        raw = (token or '').strip()
        if raw.lower().startswith('bearer '):
            raw = raw[7:].strip()
        if not raw:
            return None
        parts = raw.split('.')
        if len(parts) != 3:
            return None
        payload_b64 = parts[1]
        padding = '=' * (-len(payload_b64) % 4)
        decoded = base64.urlsafe_b64decode((payload_b64 + padding).encode('utf-8')).decode('utf-8')
        return json.loads(decoded)
    except Exception:
        return None


def _get_backend_token_status() -> str:
    token = _normalize_iwara_authorization(IWARA_AUTHORIZATION or '')
    if not token:
        return 'not_configured'
    payload = _decode_jwt_payload(token)
    if not payload or not isinstance(payload.get('exp'), (int, float)):
        return 'expired'
    return 'valid' if payload.get('exp', 0) > int(time.time()) else 'expired'


@app.errorhandler(500)
def internal_server_error(error):
    logger.error(f'服务器内部错误: {str(error)}')
    logger.error(traceback.format_exc())
    return jsonify({'error': '内部服务器错误', 'message': str(error)}), 500


@app.errorhandler(404)
def not_found_error(error):
    return jsonify({'error': '路由不存在'}), 404


@app.errorhandler(Exception)
def handle_exception(error):
    logger.error(f'未捕获的异常: {str(error)}')
    logger.error(traceback.format_exc())
    return jsonify({'error': '服务器异常'}), 500


index_html = ''
try:
    with open('./index.html', 'r', encoding='utf-8') as f:
        index_html = f.read()
except FileNotFoundError:
    index_html = '<h1>Loading...</h1>'


def filter_headers():
    headers = {
        'User-Agent': request.headers.get('User-Agent', 'Mozilla/5.0'),
        'Accept': request.headers.get('Accept', '*/*'),
    }

    if request.headers.get('Range'):
        headers['Range'] = request.headers.get('Range')
    if request.headers.get('Referer'):
        headers['Referer'] = request.headers.get('Referer')
    if request.headers.get('Origin'):
        headers['Origin'] = request.headers.get('Origin')

    upstream_authorization = _resolve_upstream_authorization()
    if upstream_authorization:
        headers['Authorization'] = upstream_authorization

    if request.headers.get('X-Version'):
        headers['X-Version'] = request.headers.get('X-Version')

    return headers


@app.route('/token-status', methods=['GET'])
def token_status():
    status = _get_backend_token_status()
    if status == 'not_configured':
        resp = Response(status=204)
        resp.headers['Retry-After'] = str(BACKEND_TOKEN_STATUS_RETRY_AFTER_SECONDS)
        return resp
    if status == 'valid':
        return Response(status=204)
    return jsonify({'code': 'backend_token_expired', 'message': '后端设置的token已过期！'}), 200


@app.route('/', methods=['GET'])
def index():
    return index_html, 200, {'content-type': 'text/html; charset=utf-8'}


def is_iwara_url(encoded_url: str) -> bool:
    try:
        decoded = unquote(encoded_url)
        parsed = urlparse(decoded)
        host = (parsed.hostname or '').lower()
        protocol_ok = parsed.scheme in ('http', 'https')
        host_ok = re.match(r'^[a-z0-9-]+\.iwara\.tv$', host) is not None
        path_ok = parsed.path == '/view'
        query_ok = bool(parsed.query)
        return protocol_ok and host_ok and path_ok and query_ok
    except Exception:
        return False


@app.route('/video/<path:subpath>', methods=['GET'])
@app.route('/videos', methods=['GET'])
def video_proxy(subpath=''):
    try:
        target_url = f'https://apiq.iwara.tv{request.full_path}'
        logger.info(f'反代请求：{target_url}')

        response = scraper.get(target_url, headers=filter_headers(), timeout=15)
        content_type = response.headers.get('content-type', '')

        if 'application/json' in content_type:
            return jsonify(response.json()), response.status_code
        return Response(response.text, status=response.status_code, content_type=content_type)

    except Exception as err:
        logger.error(f'反代出错：{err}')
        return jsonify({'error': str(err)}), 500


@app.route('/file/<path:subpath>', methods=['GET'])
def file_proxy(subpath=''):
    try:
        target_url = f'https://filesq.iwara.tv{request.full_path}'
        logger.info(f'反代请求：{target_url}')

        response = scraper.get(target_url, headers=filter_headers(), timeout=15)
        content_type = response.headers.get('content-type', '')

        if 'application/json' in content_type:
            return jsonify(response.json()), response.status_code
        return Response(response.text, status=response.status_code, content_type=content_type)

    except Exception as err:
        logger.error(f'反代出错：{err}')
        return jsonify({'error': str(err)}), 500


@app.route('/view', methods=['GET'])
def video_stream():
    try:
        video_url = request.args.get('url')
        if not video_url:
            return jsonify({'error': '缺少url参数值！'}), 400
        if not is_iwara_url(video_url):
            return jsonify({'error': '请勿滥用接口'}), 403

        response = scraper.get(video_url, headers=filter_headers(), stream=True, timeout=15)

        def generate():
            for chunk in response.iter_content(chunk_size=8192):
                yield chunk

        response_headers = dict(response.headers)
        for header in ['Content-Encoding', 'Transfer-Encoding', 'Connection']:
            response_headers.pop(header, None)

        return Response(
            stream_with_context(generate()),
            status=response.status_code,
            headers=response_headers,
            content_type=response.headers.get('content-type')
        )

    except Exception as err:
        logger.error(f'视频代理出错：{err}')
        return jsonify({'error': str(err)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port, threaded=True)
