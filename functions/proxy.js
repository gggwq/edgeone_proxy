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
    
    // 0. 注入 base 标签，让相对 URL（图片/CSS/JS）解析到目标站点
    const safeBaseHref = targetUrlStr.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const baseTag = `<base href="${safeBaseHref}">`;
    const baseRegex = /<base\s[^>]*\/?>/i;
    if (baseRegex.test(html)) {
        html = html.replace(baseRegex, baseTag);
    } else if (html.includes('<head')) {
        html = html.replace(/(<head[^>]*>)/i, '$1' + baseTag);
    } else {
        html = baseTag + html;
    }
    
    // 0.1 修复 meta refresh 重定向走代理
    html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, (match) => {
        const urlMatch = match.match(/url\s*=\s*["']?([^"'\s>]+)/i);
        if (urlMatch && urlMatch[1]) {
            try {
                const redirectUrl = new URL(urlMatch[1], targetUrlStr).href;
                return match.replace(urlMatch[1], `/proxy?url=${encodeURIComponent(redirectUrl)}`);
            } catch (e) {}
        }
        return match;
    });
    
    // 1. 添加隐藏的 url 字段到所有表单
    html = html.replace(/<form([^>]*)>/gi, (match, attrs) => {
        // 检查是否已经有 action
        if (!attrs.includes('action=')) {
            // 没有 action，添加当前目标 URL 作为 action
            return `<form${attrs} action="${proxyBase}${encodeURIComponent(targetUrlStr)}">`;
        }
        return match;
    });
    
    // 2. 注入 JavaScript 来修复所有导航（点击、表单、JS跳转）
    const safeTargetUrl = targetUrlStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const safeTargetOrigin = targetOrigin.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    
    const fixScript = `
<script>
(function() {
    var targetUrl = "${safeTargetUrl}";
    var targetOrigin = "${safeTargetOrigin}";
    var proxyBase = "/proxy?url=";
    var proxyPrefix = "/proxy?";
    
    function toProxyUrl(url) {
        return proxyBase + encodeURIComponent(url);
    }
    
    function resolveFullUrl(href) {
        if (href.startsWith('http')) return href;
        if (href.startsWith('/')) return targetOrigin + href;
        return new URL(href, targetUrl).href;
    }
    
    function needsProxy(url) {
        return url && !url.includes(proxyPrefix) && !url.startsWith('#') && !url.startsWith('javascript:');
    }
    
    // 拦截 window.location.assign
    var _assign = window.location.assign.bind(window.location);
    window.location.assign = function(url) {
        url = String(url);
        if (needsProxy(url)) url = toProxyUrl(resolveFullUrl(url));
        return _assign(url);
    };
    
    // 拦截 window.location.replace
    var _replaceLoc = window.location.replace.bind(window.location);
    window.location.replace = function(url) {
        url = String(url);
        if (needsProxy(url)) url = toProxyUrl(resolveFullUrl(url));
        return _replaceLoc(url);
    };
    
    // 拦截 history.pushState
    var _pushState = history.pushState.bind(history);
    history.pushState = function(state, title, url) {
        if (url && needsProxy(url)) url = toProxyUrl(resolveFullUrl(url));
        return _pushState(state, title, url);
    };
    
    // 拦截 history.replaceState
    var _replaceState = history.replaceState.bind(history);
    history.replaceState = function(state, title, url) {
        if (url && needsProxy(url)) url = toProxyUrl(resolveFullUrl(url));
        return _replaceState(state, title, url);
    };
    
    // 修复所有表单提交
    document.addEventListener('submit', function(e) {
        var form = e.target;
        var action = form.getAttribute('action') || '';
        
        if (!action || !action.includes(proxyPrefix)) {
            e.preventDefault();
            
            var fullAction;
            if (!action) {
                fullAction = targetUrl;
            } else if (action.startsWith('http')) {
                fullAction = action;
            } else if (action.startsWith('/')) {
                fullAction = targetOrigin + action;
            } else {
                fullAction = new URL(action, targetUrl).href;
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
            
            var url = toProxyUrl(fullAction);
            
            if (form.method.toUpperCase() === 'GET') {
                window.location.assign(url);
            } else {
                var newForm = document.createElement('form');
                newForm.method = 'POST';
                newForm.action = url;
                newForm.style.display = 'none';
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
            if (needsProxy(href)) {
                e.preventDefault();
                e.stopPropagation();
                window.open(toProxyUrl(resolveFullUrl(href)), '_blank');
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
