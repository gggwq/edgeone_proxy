/**
 * EdgeOne Pages proxy function (支持HTML重写)
 * 
 * 新增功能：
 * 1. HTML链接重写 - 把页面中的链接改成代理链接
 * 2. 表单action重写
 * 3. 相对路径处理
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

        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response('Only http and https protocols are supported.', { status: 400 });
        }

        // 构建请求头
        const outgoingHeaders = new Headers();
        
        // 复制必要的请求头
        const headersToCopy = ['accept', 'accept-language', 'user-agent', 'cookie', 'referer'];
        for (const headerName of headersToCopy) {
            const value = request.headers.get(headerName);
            if (value) {
                outgoingHeaders.set(headerName, value);
            }
        }

        // 不发送 Accept-Encoding，让 fetch 自动处理压缩
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

        // 复制响应头，排除有问题的
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

        // 关键：HTML 重写
        const contentType = response.headers.get('content-type') || '';
        
        if (contentType.includes('text/html')) {
            // 读取 HTML 内容
            let html = await response.text();
            
            // 获取目标网站的基础 URL
            const targetBase = targetUrl.origin;
            const proxyBase = '/proxy?url=';
            
            // 重写链接的正则表达式
            // 1. 重写 <a href="...">
            html = html.replace(/<a([^>]*?)href=["']([^"']*)["']([^>]*?)>/gi, (match, before, href, after) => {
                const newHref = rewriteUrl(href, targetBase, proxyBase);
                return `<a${before}href="${newHref}"${after}>`;
            });
            
            // 2. 重写 <form action="...">
            html = html.replace(/<form([^>]*?)action=["']([^"']*)["']([^>]*?)>/gi, (match, before, action, after) => {
                const newAction = rewriteUrl(action, targetBase, proxyBase);
                return `<form${before}action="${newAction}"${after}>`;
            });
            
            // 3. 重写 <img src="..."> 和 <script src="...">
            html = html.replace(/(src|href)=["']([^"']*)["']/gi, (match, attr, url) => {
                // 只重写非 a/form 标签的 src/href
                if (match.includes('<a ') || match.includes('<form ')) return match;
                
                const newUrl = rewriteResourceUrl(url, targetBase);
                return `${attr}="${newUrl}"`;
            });
            
            // 返回重写后的 HTML
            return new Response(html, {
                status: response.status,
                statusText: response.statusText,
                headers: finalHeaders
            });
        }
        
        // 非 HTML 内容，直接返回
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
 * 重写 URL（用于链接和表单）
 */
function rewriteUrl(url, targetBase, proxyBase) {
    if (!url || url.startsWith('#') || url.startsWith('javascript:')) {
        return url;
    }
    
    // 已经是代理 URL，不重写
    if (url.startsWith('/proxy?')) {
        return url;
    }
    
    // 绝对 URL（完整 URL）
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return `/proxy?url=${encodeURIComponent(url)}`;
    }
    
    // 协议相对 URL
    if (url.startsWith('//')) {
        return `/proxy?url=${encodeURIComponent('https:' + url)}`;
    }
    
    // 根相对路径
    if (url.startsWith('/')) {
        return `/proxy?url=${encodeURIComponent(targetBase + url)}`;
    }
    
    // 相对路径（如 "./page" 或 "../page"）
    // 注意：这里简化处理了，完整的应该基于当前 URL 解析
    return `/proxy?url=${encodeURIComponent(targetBase + '/' + url)}`;
}

/**
 * 重写资源 URL（图片、CSS、JS等）
 * 资源可以直接代理，不需要通过 /proxy?url= 包装
 */
function rewriteResourceUrl(url, targetBase) {
    if (!url || url.startsWith('#') || url.startsWith('data:')) {
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
    
    // 相对路径，拼接成完整 URL 后再代理
    if (url.startsWith('//')) {
        return `/proxy?url=${encodeURIComponent('https:' + url)}`;
    }
    
    if (url.startsWith('/')) {
        return `/proxy?url=${encodeURIComponent(targetBase + url)}`;
    }
    
    return `/proxy?url=${encodeURIComponent(targetBase + '/' + url)}`;
}
