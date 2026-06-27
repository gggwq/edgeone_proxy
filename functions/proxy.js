/**
 * EdgeOne Pages proxy function (智能修复版)
 * 
 * 核心改进：
 * 1. 当请求 /proxy 缺少 url 参数时，尝试从 Referer 中提取
 * 2. 自动修复表单 action，添加当前目标 URL 作为隐藏字段
 * 3. 注入 JS 确保所有导航都通过代理
 */

function isPrivateHost(hostname) {
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
    }
    if (['localhost', '0.0.0.0', '127.0.0.1', '::1'].includes(hostname.toLowerCase())) {
        return true;
    }
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const p = ipv4.slice(1).map(Number);
        if (p.every(v => v <= 255)) {
            if (p[0] === 10) return true;
            if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
            if (p[0] === 192 && p[1] === 168) return true;
            if (p[0] === 127) return true;
            if (p[0] === 169 && p[1] === 254) return true;
            if (p[0] === 0) return true;
        }
    }
    return false;
}

export async function onRequest(context) {
    const { request } = context;

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
        let targetUrlParam = requestUrl.searchParams.get('url') || requestUrl.searchParams.get('u');

        // 关键修复：如果没有 url 参数，尝试从 Referer 中提取
        if (!targetUrlParam) {
            const referer = request.headers.get('referer');
            if (referer) {
                try {
                    const refererUrl = new URL(referer);
                    targetUrlParam = refererUrl.searchParams.get('url') || refererUrl.searchParams.get('u');
                    
                    if (targetUrlParam) {
                        // 重定向到正确的代理 URL
                        const currentPath = requestUrl.pathname;
                        const currentParams = new URLSearchParams(requestUrl.search);
                        
                        // 构造新的代理 URL，保留原始查询参数
                        let newProxyUrl = `/proxy?url=${encodeURIComponent(targetUrlParam)}`;
                        
                        // 添加原始的查询参数（如 Google 的 q=1+1）
                        for (const [key, value] of currentParams.entries()) {
                            if (key !== 'url' && key !== 'u') {
                                newProxyUrl += `&${key}=${encodeURIComponent(value)}`;
                            }
                        }
                        
                        return new Response(null, {
                            status: 302,
                            headers: {
                                'Location': newProxyUrl,
                                'Access-Control-Allow-Origin': '*'
                            }
                        });
                    }
                } catch (e) {}
            }
            
            // 如果还是没有 url 参数，返回错误
            return new Response('Missing url parameter. Please use /proxy?url=<target_url>', { 
                status: 400,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }

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
        const targetOrigin = targetUrl.origin;

        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response('Only http and https protocols are supported.', { status: 400 });
        }

        if (isPrivateHost(targetUrl.hostname)) {
            return new Response('Access to internal/private addresses is not allowed.', { status: 403 });
        }

        const outgoingHeaders = new Headers();
        
        const headersToCopy = ['accept', 'accept-language', 'user-agent', 'referer'];
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

        const finalHeaders = new Headers();

        const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length', 'set-cookie'];
        for (const [key, value] of response.headers.entries()) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                finalHeaders.set(key, value);
            }
        }

        const rewriteSetCookie = (cookie) => {
            if (!cookie) return cookie;
            return cookie
                .replace(/;\s*Domain=[^;]*/gi, '')
                .replace(/;\s*domain=[^;]*/gi, '')
                .replace(/;\s*SameSite=[^;]*/gi, '; SameSite=None');
        };

        for (const [key, value] of response.headers.entries()) {
            if (key.toLowerCase() === 'set-cookie') {
                const rewritten = rewriteSetCookie(value.trim());
                if (rewritten) {
                    finalHeaders.append('Set-Cookie', rewritten);
                }
            }
        }

        finalHeaders.set('Access-Control-Allow-Origin', '*');
        finalHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        finalHeaders.set('Access-Control-Allow-Headers', '*');

        const contentType = response.headers.get('content-type') || '';
        
        if (contentType.includes('text/html')) {
            let html = await response.text();
            
            // 注入智能修复脚本
            html = injectSmartFix(html, targetUrlStr, targetOrigin);
            
            return new Response(html, {
                status: response.status,
                statusText: response.statusText,
                headers: finalHeaders
            });
        }
        
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
 * 注入智能修复脚本
 */
function injectSmartFix(html, targetUrlStr, targetOrigin) {
    const proxyBase = '/proxy?url=';
    
    // 1. 添加隐藏的 url 字段到所有表单
    html = html.replace(/<form([^>]*)>/gi, (match, attrs) => {
        // 检查是否已经有 action
        if (!attrs.includes('action=')) {
            // 没有 action，添加当前目标 URL 作为 action
            return `<form${attrs} action="${proxyBase}${encodeURIComponent(targetUrlStr)}">`;
        }
        return match;
    });
    
    // 2. 注入 JavaScript 来修复表单提交
    const fixScript = `
<script>
(function() {
    var targetUrl = "${targetUrlStr}";
    var targetOrigin = "${targetOrigin}";
    var proxyBase = "/proxy?url=";
    
    // 修复所有表单提交
    document.addEventListener('submit', function(e) {
        var form = e.target;
        
        // 获取表单的 action
        var action = form.getAttribute('action') || '';
        
        // 如果 action 不包含 /proxy?，需要重写
        if (action && !action.includes('/proxy?')) {
            e.preventDefault();
            
            // 构造完整的目标 URL
            var fullAction;
            if (action.startsWith('http')) {
                fullAction = action;
            } else if (action.startsWith('/')) {
                fullAction = targetOrigin + action;
            } else if (action) {
                fullAction = new URL(action, targetUrl).href;
            } else {
                fullAction = targetUrl;
            }
            
            var formData = new FormData(form);
            var params = new URLSearchParams();
            for (var pair of formData.entries()) {
                params.append(pair[0], pair[1]);
            }
            
            var paramStr = params.toString();
            if (paramStr) {
                fullAction += (fullAction.includes('?') ? '&' : '?') + paramStr;
            }
            
            var proxyUrl = proxyBase + encodeURIComponent(fullAction);
            
            if (form.method.toUpperCase() === 'GET') {
                window.location.href = proxyUrl;
            } else {
                // POST 请求，创建新表单
                var newForm = document.createElement('form');
                newForm.method = 'POST';
                newForm.action = proxyUrl;
                
                for (var pair of formData.entries()) {
                    var input = document.createElement('input');
                    input.type = 'hidden';
                    input.name = pair[0];
                    input.value = pair[1];
                    newForm.appendChild(input);
                }
                
                document.body.appendChild(newForm);
                newForm.submit();
            }
        }
    }, true);
    
    // 修复所有链接点击
    document.addEventListener('click', function(e) {
        var link = e.target.closest('a');
        if (link && link.href) {
            var href = link.getAttribute('href');
            
            // 如果链接不是代理 URL，重写
            if (href && !href.includes('/proxy?') && !href.startsWith('#') && !href.startsWith('javascript:')) {
                e.preventDefault();
                
                var fullUrl;
                if (href.startsWith('http')) {
                    fullUrl = href;
                } else if (href.startsWith('/')) {
                    fullUrl = targetOrigin + href;
                } else {
                    fullUrl = new URL(href, targetUrl).href;
                }
                
                window.open(proxyBase + encodeURIComponent(fullUrl), '_blank');
            }
        }
    }, true);
})();
</script>
`;
    
    // 注入脚本
    if (html.includes('</head>')) {
        html = html.replace('</head>', fixScript + '</head>');
    } else if (html.includes('</body>')) {
        html = html.replace('</body>', fixScript + '</body>');
    } else {
        html += fixScript;
    }
    
    return html;
}
