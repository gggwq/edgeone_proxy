/**
 * EdgeOne Pages proxy function (调试版)
 * 
 * 添加详细日志来帮助诊断问题
 */

export async function onRequest(context) {
    const { request } = context;

    // 日志函数
    const log = (msg) => {
        console.log(`[Proxy] ${msg}`);
    };

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

        log(`Request URL: ${request.url}`);
        log(`Target URL param: ${targetUrlParam}`);

        if (!targetUrlParam) {
            // 诊断：显示所有查询参数
            const allParams = {};
            for (const [key, value] of requestUrl.searchParams.entries()) {
                allParams[key] = value;
            }
            log(`Missing url parameter. All params: ${JSON.stringify(allParams)}`);
            
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
        } catch (e) {
            log(`URL decode error: ${e.message}`);
        }

        const targetUrl = new URL(targetUrlStr);
        const targetOrigin = targetUrl.origin;

        log(`Target URL: ${targetUrl.href}`);
        log(`Target Origin: ${targetOrigin}`);

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

        log(`Fetching: ${targetUrl.href}`);

        const modifiedRequest = new Request(targetUrl.href, {
            headers: outgoingHeaders,
            method: request.method,
            body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
            redirect: 'manual',
            duplex: 'half'
        });

        const response = await fetch(modifiedRequest);

        log(`Response status: ${response.status}`);

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (location) {
                const redirectUrl = new URL(location, targetUrl).href;
                log(`Redirect to: ${redirectUrl}`);
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
            
            log(`HTML length: ${html.length}`);
            
            // 注入调试脚本和重写 URL
            html = injectProxyScriptDebug(html, targetUrlStr, targetOrigin);
            
            return new Response(html, {
                status: response.status,
                statusText: response.statusText,
                headers: finalHeaders
            });
        }
        
        log(`Non-HTML response, content-type: ${contentType}`);
        
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
        });

    } catch (error) {
        log(`Error: ${error.message}`);
        log(`Stack: ${error.stack}`);
        return new Response(`Proxy Error: ${error.message}<br><br>Stack: ${error.stack}`, { 
            status: 500,
            headers: {
                'Content-Type': 'text/html; charset=utf-8'
            }
        });
    }
}

/**
 * 注入代理脚本（调试版）
 */
function injectProxyScriptDebug(html, currentTargetUrl, targetOrigin) {
    log(`Rewriting HTML...`);
    
    // 1. 重写静态的链接和表单
    html = rewriteStaticUrls(html, targetOrigin);
    
    log(`Static URLs rewritten`);
    
    // 2. 注入 JavaScript（调试版）
    const proxyScript = `
<script>
(function() {
    var currentTargetUrl = "${currentTargetUrl}";
    var targetOrigin = "${targetOrigin}";
    var proxyBase = "/proxy?url=";
    
    console.log("[Proxy Debug] Script loaded");
    console.log("[Proxy Debug] currentTargetUrl:", currentTargetUrl);
    console.log("[Proxy Debug] targetOrigin:", targetOrigin);
    
    // 重写 URL 的函数
    function rewriteUrl(url) {
        if (!url || url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('data:')) {
            return url;
        }
        
        console.log("[Proxy Debug] Rewriting URL:", url);
        
        // 已经是代理 URL
        if (url.startsWith('/proxy?')) {
            console.log("[Proxy Debug] Already proxied, skipping");
            return url;
        }
        
        // 绝对 URL
        if (url.startsWith('http://') || url.startsWith('https://')) {
            var result = proxyBase + encodeURIComponent(url);
            console.log("[Proxy Debug] Absolute URL rewritten to:", result);
            return result;
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
        console.log("[Proxy Debug] Click intercepted", e.target);
        var target = e.target.closest('a');
        if (target && target.href) {
            e.preventDefault();
            var newUrl = rewriteUrl(target.href);
            console.log("[Proxy Debug] Opening:", newUrl);
            window.open(newUrl, '_blank');
        }
    }, true);
    
    // 拦截所有表单提交
    document.addEventListener('submit', function(e) {
        console.log("[Proxy Debug] Form submit intercepted", e.target);
        var form = e.target;
        if (form.action) {
            e.preventDefault();
            console.log("[Proxy Debug] Original action:", form.action);
            var newAction = rewriteUrl(form.action);
            console.log("[Proxy Debug] New action:", newAction);
            
            // 创建新的表单并提交
            var newForm = document.createElement('form');
            newForm.method = form.method || 'GET';
            newForm.action = newAction;
            
            // 复制表单数据
            var formData = new FormData(form);
            for (var pair of formData.entries()) {
                console.log("[Proxy Debug] Form field:", pair[0], pair[1]);
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
    
    // 重写 <base> 标签
    var baseTag = document.querySelector('base');
    if (baseTag) {
        baseTag.href = '/proxy?url=' + encodeURIComponent(targetOrigin + '/');
        console.log("[Proxy Debug] Base tag rewritten to:", baseTag.href);
    }
    
    console.log("[Proxy Debug] All interceptors installed");
})();
</script>
`;
    
    // 在 </head> 前注入脚本
    if (html.includes('</head>')) {
        html = html.replace('</head>', proxyScript + '</head>');
        log(`Script injected before </head>`);
    } else if (html.includes('</body>')) {
        html = html.replace('</body>', proxyScript + '</body>');
        log(`Script injected before </body>`);
    } else {
        html += proxyScript;
        log(`Script appended to end`);
    }
    
    return html;
}

/**
 * 重写静态的 URL
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
        if (!action) {
            // 没有 action，使用当前 URL
            action = baseUrl + '/';
        }
        console.log(`[Rewrite] Form action: ${action} -> ${rewriteSingleUrl(action, baseUrl)}`);
        var newAction = rewriteSingleUrl(action, baseUrl);
        return '<form' + before + 'action="' + newAction + '"' + after + '>';
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

function log(msg) {
    console.log(msg);
}
