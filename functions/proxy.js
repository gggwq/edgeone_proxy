/**
 * EdgeOne Pages proxy function (修复链接重写)
 * 
 * 修复：正确拼接目标网站的域名
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
            },
        });
    }

    try {
        const requestUrl = new URL(request.url);
        const targetUrlParam = requestUrl.searchParams.get('url') || requestUrl.searchParams.get('u');

        if (!targetUrlParam) {
            return new Response('Missing url parameter', { status: 400 });
        }

        // URL 解码和规范化
        let targetUrlStr = targetUrlParam;
        try {
            if (targetUrlStr.includes('%')) {
                targetUrlStr = decodeURIComponent(targetUrlStr);
            }
            if (!targetUrlStr.startsWith('http')) {
                targetUrlStr = 'https://' + targetUrlStr;
            }
        } catch (e) {}

        const targetUrl = new URL(targetUrlStr);
        const targetOrigin = targetUrl.origin; // 例如：https://www.google.com

        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response('Only http and https protocols are supported.', { status: 400 });
        }

        // 构建请求头
        const outgoingHeaders = new Headers();
        
        const headersToCopy = ['accept', 'accept-language', 'user-agent', 'cookie', 'referer'];
        for (const headerName of headersToCopy) {
            const value = request.headers.get(headerName);
            if (value) {
                outgoingHeaders.set(headerName, value);
            }
        }

        outgoingHeaders.delete('accept-encoding');

        if (!outgoingHeaders.has('user-agent')) {
            outgoingHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        }

        const modifiedRequest = new Request(targetUrl.href, {
            headers: outgoingHeaders,
            method: request.method,
            body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
            redirect: 'manual',
            duplex: 'half'
        });

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

        // 构建响应头
        const finalHeaders = new Headers();

        const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length', 'set-cookie'];
        for (const [key, value] of response.headers.entries()) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                finalHeaders.set(key, value);
            }
        }

        // Cookie 重写
        const rewriteSetCookie = (cookie) => {
            if (!cookie) return cookie;
            return cookie
                .replace(/;\s*Domain=[^;]*/gi, '')
                .replace(/;\s*domain=[^;]*/gi, '')
                .replace(/;\s*SameSite=[^;]*/gi, '; SameSite=None');
        };

        if (response.headers.get('set-cookie')) {
            const cookies = response.headers.get('set-cookie').split(/,(?=\s*\w+=)/);
            for (const cookie of cookies) {
                const rewritten = rewriteSetCookie(cookie.trim());
                if (rewritten) {
                    finalHeaders.append('Set-Cookie', rewritten);
                }
            }
        }

        finalHeaders.set('Access-Control-Allow-Origin', '*');
        finalHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        finalHeaders.set('Access-Control-Allow-Headers', '*');

        // HTML 重写
        const contentType = response.headers.get('content-type') || '';
        
        if (contentType.includes('text/html')) {
            let html = await response.text();
            
            // 使用正确的基础 URL
            const baseUrl = targetOrigin; // 例如：https://www.google.com
            
            // 重写链接
            html = rewriteHtmlUrls(html, baseUrl);
            
            return new Response(html, {
                status: response.status,
                statusText: response.statusText,
                headers: finalHeaders
            });
        }
        
        // 非 HTML 内容
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
        });

    } catch (error) {
        return new Response(`Proxy Error: ${error.message}`, { status: 500 });
    }
}

/**
 * 重写 HTML 中的所有 URL
 */
function rewriteHtmlUrls(html, baseUrl) {
    // 1. 重写 <a href="...">
    html = html.replace(/<a([^>]*?)href=["']([^"']*)["']([^>]*?)>/gi, (match, before, href, after) => {
        const newHref = rewriteSingleUrl(href, baseUrl);
        return `<a${before}href="${newHref}"${after}>`;
    });
    
    // 2. 重写 <form action="...">
    html = html.replace(/<form([^>]*?)action=["']([^"']*)["']([^>]*?)>/gi, (match, before, action, after) => {
        const newAction = rewriteSingleUrl(action, baseUrl);
        return `<form${before}action="${newAction}"${after}>`;
    });
    
    // 3. 重写资源 URL (src, href in non-a/form tags)
    html = html.replace(/(<(?:img|script|link|iframe)[^>]*?)(src|href)=["']([^"']*)["']([^>]*?>)/gi, (match, tagStart, attr, url, tagEnd) => {
        const newUrl = rewriteSingleUrl(url, baseUrl);
        return `${tagStart}${attr}="${newUrl}"${tagEnd}`;
    });
    
    return html;
}

/**
 * 重写单个 URL
 */
function rewriteSingleUrl(url, baseUrl) {
    if (!url || url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('data:')) {
        return url;
    }
    
    // 已经是代理 URL
    if (url.startsWith('/proxy?')) {
        return url;
    }
    
    // 绝对 URL
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return `/proxy?url=${encodeURIComponent(url)}`;
    }
    
    // 协议相对 URL
    if (url.startsWith('//')) {
        return `/proxy?url=${encodeURIComponent('https:' + url)}`;
    }
    
    // 根相对路径 (以 / 开头)
    if (url.startsWith('/')) {
        return `/proxy?url=${encodeURIComponent(baseUrl + url)}`;
    }
    
    // 相对路径 (如 "./page" 或 "../page")
    // 简单处理：直接拼接到 baseUrl 后面
    // 更完整的实现应该基于当前页面的 URL 解析
    const separator = baseUrl.endsWith('/') ? '' : '/';
    return `/proxy?url=${encodeURIComponent(baseUrl + separator + url)}`;
}
