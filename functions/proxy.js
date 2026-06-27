/**
 * EdgeOne Pages proxy function (完整修复版)
 * 
 * 完整解决方案：
 * 1. 重写 HTML 中的链接和表单
 * 2. 注入 JavaScript 拦截所有动态导航
 * 3. 添加 <base> 标签处理相对路径
 */

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
        const targetUrlParam = requestUrl.searchParams.get('url') || requestUrl.searchParams.get('u');

        if (!targetUrlParam) {
            return new Response('Missing url parameter', { status: 400 });
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
        const currentProxyUrl = targetUrlStr; // 当前代理的完整目标 URL

        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response('Only http and https protocols are supported.', { status: 400 });
        }

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

        const contentType = response.headers.get('content-type') || '';
        
        if (contentType.includes('text/html')) {
            let html = await response.text();
            
            // 注入拦截脚本和重写的 URL
            html = injectProxyScript(html, currentProxyUrl, targetOrigin);
            
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
 * 注入代理脚本和重写 HTML
 */
function injectProxyScript(html, currentTargetUrl, targetOrigin) {
    // 1. 重写静态的链接和表单
    html = rewriteStaticUrls(html, targetOrigin);
    
    // 2. 注入 JavaScript 来拦截动态导航
    const proxyScript = `
<script>
(function() {
    var currentTargetUrl = "${currentTargetUrl}";
    var targetOrigin = "${targetOrigin}";
    var proxyBase = "/proxy?url=";
    
    // 重写 URL 的函数
    function rewriteUrl(url) {
        if (!url || url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('data:')) {
            return url;
        }
        
        // 已经是代理 URL
        if (url.startsWith('/proxy?')) {
            return url;
        }
        
        // 绝对 URL
        if (url.startsWith('http://') || url.startsWith('https://')) {
            return proxyBase + encodeURIComponent(url);
        }
        
        // 协议相对 URL
        if (url.startsWith('//')) {
            return proxyBase + encodeURIComponent('https:' + url);
        }
        
        // 相对路径
        if (url.startsWith('/')) {
            return proxyBase + encodeURIComponent(targetOrigin + url);
        }
        
        // 相对路径（./ 或 ../）
        return proxyBase + encodeURIComponent(targetOrigin + '/' + url);
    }
    
    // 拦截所有链接点击
    document.addEventListener('click', function(e) {
        var target = e.target.closest('a');
        if (target && target.href) {
            e.preventDefault();
            var newUrl = rewriteUrl(target.href);
            window.open(newUrl, '_blank');
        }
    }, true);
    
    // 拦截所有表单提交
    document.addEventListener('submit', function(e) {
        var form = e.target;
        if (form.action) {
            e.preventDefault();
            var newAction = rewriteUrl(form.action);
            
            // 创建新的表单并提交
            var newForm = document.createElement('form');
            newForm.method = form.method || 'GET';
            newForm.action = newAction;
            
            // 复制表单数据
            var formData = new FormData(form);
            for (var pair of formData.entries()) {
                var input = document.createElement('input');
                input.type = 'hidden';
                input.name = pair[0];
                input.value = pair[1];
                newForm.appendChild(input);
            }
            
            document.body.appendChild(newForm);
            newForm.submit();
            document.body.removeChild(newForm);
        }
    }, true);
    
    // 拦截 window.open 和 location changes
    var originalOpen = window.open;
    window.open = function(url) {
        if (url) {
            arguments[0] = rewriteUrl(url);
        }
        return originalOpen.apply(this, arguments);
    };
    
    // 重写 <base> 标签的 href
    var baseTag = document.querySelector('base');
    if (baseTag) {
        baseTag.href = '/proxy?url=' + encodeURIComponent(targetOrigin + '/');
    }
})();
</script>
`;
    
    // 在 </head> 前注入脚本
    if (html.includes('</head>')) {
        html = html.replace('</head>', proxyScript + '</head>');
    } else if (html.includes('</body>')) {
        html = html.replace('</body>', proxyScript + '</body>');
    } else {
        html += proxyScript;
    }
    
    return html;
}

/**
 * 重写静态的 URL（链接、表单等）
 */
function rewriteStaticUrls(html, baseUrl) {
    // 重写 <a href>
    html = html.replace(/<a([^>]*?)href=["']([^"']*)["']([^>]*?)>/gi, function(match, before, href, after) {
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
            return match;
        }
        var newHref = rewriteSingleUrl(href, baseUrl);
        return '<a' + before + 'href="' + newHref + '"' + after + '>';
    });
    
    // 重写 <form action>
    html = html.replace(/<form([^>]*?)action=["']([^"']*)["']([^>]*?)>/gi, function(match, before, action, after) {
        if (!action) return match;
        var newAction = rewriteSingleUrl(action, baseUrl);
        return '<form' + before + 'action="' + newAction + '"' + after + '>';
    });
    
    // 重写资源 URL
    html = html.replace(/(src|href)=["']([^"']*)["']/gi, function(match, attr, url) {
        if (match.includes('<a ') || match.includes('<form ')) return match;
        if (!url || url.startsWith('#') || url.startsWith('data:')) return match;
        var newUrl = rewriteSingleUrl(url, baseUrl);
        return attr + '="' + newUrl + '"';
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
    
    if (url.startsWith('/proxy?')) {
        return url;
    }
    
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return '/proxy?url=' + encodeURIComponent(url);
    }
    
    if (url.startsWith('//')) {
        return '/proxy?url=' + encodeURIComponent('https:' + url);
    }
    
    if (url.startsWith('/')) {
        return '/proxy?url=' + encodeURIComponent(baseUrl + url);
    }
    
    var separator = baseUrl.endsWith('/') ? '' : '/';
    return '/proxy?url=' + encodeURIComponent(baseUrl + separator + url);
}
