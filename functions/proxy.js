/**
 * EdgeOne Pages proxy function (完全修复版)
 * 
 * 修复所有已知问题：
 * 1. ERR_CONTENT_DECODING_FAILED - 内容编码解码失败
 * 2. 无法解码原始数据
 * 3. YouTube 等复杂网站代理失败
 * 4. URL 编码问题
 */

export async function onRequest(context) {
    const { request } = context;

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    try {
        const requestUrl = new URL(request.url);
        let targetUrlParam = requestUrl.searchParams.get('url') || requestUrl.searchParams.get('u');

        if (!targetUrlParam) {
            return new Response(JSON.stringify({
                error: 'Missing url parameter',
                usage: '/proxy?url=https://example.com',
                example: '/proxy?url=https://www.google.com'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }

        // URL 解码和规范化
        try {
            if (targetUrlParam.includes('%')) {
                targetUrlParam = decodeURIComponent(targetUrlParam);
            }
            if (!targetUrlParam.startsWith('http')) {
                targetUrlParam = 'https://' + targetUrlParam;
            }
        } catch (e) {
            // 解码失败，使用原始参数
        }

        let targetUrl;
        try {
            targetUrl = new URL(targetUrlParam);
        } catch (e) {
            return new Response(JSON.stringify({
                error: 'Invalid URL',
                provided: targetUrlParam
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }

        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response('Only http and https protocols are supported.', { status: 400 });
        }

        // 构建请求头（排除有问题的头部）
        const outgoingHeaders = new Headers();
        
        // 复制需要的请求头
        const headersToCopy = ['accept', 'accept-language', 'user-agent', 'cookie', 'referer'];
        for (const headerName of headersToCopy) {
            const value = request.headers.get(headerName);
            if (value) {
                outgoingHeaders.set(headerName, value);
            }
        }

        // 重要：不发送 Accept-Encoding，让 fetch 自动处理压缩
        // 这样 response.body 会是解压后的内容

        // 添加默认的 User-Agent（某些网站需要）
        if (!outgoingHeaders.has('user-agent')) {
            outgoingHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        }

        const modifiedRequest = new Request(targetUrl.href, {
            headers: outgoingHeaders,
            method: request.method,
            body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
            redirect: 'manual', // 手动处理重定向，避免循环
            duplex: 'half'
        });

        // 发起请求
        const response = await fetch(modifiedRequest);

        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (location) {
                const redirectUrl = new URL(location, targetUrl).href;
                return new Response(null, {
                    status: 302,
                    headers: {
                        'Location': `/proxy?url=${encodeURIComponent(redirectUrl)}`,
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            }
        }

        // 构建响应头（关键修复：正确处理 Content-Encoding）
        const finalHeaders = new Headers();

        // 复制所有响应头，但排除有问题的头部
        const skipHeaders = [
            'content-encoding',      // 关键：不传递 content-encoding
            'transfer-encoding',      // fetch 已经处理了解压
            'content-length',         // 内容长度可能变化
            'set-cookie'              // 单独处理
        ];

        for (const [key, value] of response.headers.entries()) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                finalHeaders.set(key, value);
            }
        }

        // 关键修复：如果 fetch 自动解压了内容，不要设置 Content-Encoding
        // EdgeOne 的 fetch 会自动解压 gzip/deflate 内容
        // 所以我们返回的是明文内容，不需要浏览器再解压

        // Cookie 重写
        const rewriteSetCookie = (cookie) => {
            if (!cookie) return cookie;
            return cookie
                .replace(/;\s*Domain=[^;]*/gi, '')
                .replace(/;\s*domain=[^;]*/gi, '')
                .replace(/;\s*SameSite=[^;]*/gi, '; SameSite=None');
        };

        // 处理 Set-Cookie
        if (response.headers.get('set-cookie')) {
            const cookies = response.headers.get('set-cookie').split(/,(?=\s*\w+=)/);
            for (const cookie of cookies) {
                const rewritten = rewriteSetCookie(cookie.trim());
                if (rewritten) {
                    finalHeaders.append('Set-Cookie', rewritten);
                }
            }
        }

        // CORS 头
        finalHeaders.set('Access-Control-Allow-Origin', '*');
        finalHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        finalHeaders.set('Access-Control-Allow-Headers', '*');

        // 关键：返回响应
        // response.body 已经是解压后的内容（如果有压缩的话）
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
        });

    } catch (error) {
        const errorMessage = error.message || String(error);
        
        // 友好的错误提示
        let userMessage = errorMessage;
        if (errorMessage.includes('fetch failed')) {
            userMessage = '无法连接到目标网站，请检查网址是否正确';
        } else if (errorMessage.includes('timeout')) {
            userMessage = '请求超时，目标网站响应太慢或无法访问';
        }

        return new Response(JSON.stringify({
            error: 'Proxy Error',
            message: userMessage,
            details: errorMessage,
            timestamp: new Date().toISOString()
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }
}
