/**
 * EdgeOne Pages proxy function (改进版)
 * 
 * 修复问题：
 * 1. URL 编码/解码问题
 * 2. 压缩内容处理 (gzip/deflate)
 * 3. 二进制文件传输
 * 4. 更详细的错误信息
 * 5. 更好的兼容性
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
        let targetUrlParam = requestUrl.searchParams.get('url');

        // 修复1: 如果没有 url 参数，检查是否有 u 参数（某些前端使用短参数名）
        if (!targetUrlParam) {
            targetUrlParam = requestUrl.searchParams.get('u');
        }

        if (!targetUrlParam) {
            return new Response(JSON.stringify({
                error: '缺少 url 参数',
                usage: '/proxy?url=目标网址',
                example: '/proxy?url=https://www.google.com'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }

        // 修复2: 确保 URL 正确解码
        try {
            // 如果 URL 是编码的，先解码
            if (targetUrlParam.includes('%')) {
                targetUrlParam = decodeURIComponent(targetUrlParam);
            }
            // 如果是相对路径或缺少协议，尝试补全
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
                error: '无效的 URL',
                provided: targetUrlParam,
                message: '请确保 URL 格式正确，例如：https://www.example.com'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }

        // 只允许 http 和 https 协议
        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response(JSON.stringify({
                error: '不支持的协议',
                protocol: targetUrl.protocol,
                message: '仅支持 http 和 https 协议'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }

        // 修复3: 更智能的头部处理
        const outgoingHeaders = new Headers();
        
        // 复制原始请求的头部（除了 host 和某些敏感头部）
        const skipHeaders = ['host', 'content-length', 'transfer-encoding'];
        for (const [key, value] of request.headers.entries()) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                outgoingHeaders.set(key, value);
            }
        }

        // 添加默认的 User-Agent（某些网站需要）
        if (!outgoingHeaders.has('user-agent')) {
            outgoingHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        }

        // 修复4: 不自动添加 Accept-Encoding，让 fetch 自动处理压缩
        // 这样可以避免手动解压的复杂性

        const modifiedRequest = new Request(targetUrl.href, {
            headers: outgoingHeaders,
            method: request.method,
            body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
            redirect: 'manual',
            // 重要：设置 duplex 为 half 以支持流式传输
            duplex: 'half'
        });

        // 发起请求
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

        // 修复5: 更完善的响应头处理
        const finalHeaders = new Headers();

        // 复制所有响应头（除了某些需要处理的）
        const skipResponseHeaders = ['content-encoding', 'transfer-encoding', 'set-cookie'];
        for (const [key, value] of response.headers.entries()) {
            if (!skipResponseHeaders.includes(key.toLowerCase())) {
                finalHeaders.set(key, value);
            }
        }

        // 修复6: Cookie 重写（移除 Domain 限制）
        const rewriteSetCookie = (cookie) => {
            if (!cookie) return cookie;
            return cookie
                .replace(/;\s*Domain=[^;]*/gi, '')
                .replace(/;\s*domain=[^;]*/gi, '')
                .replace(/;\s*SameSite=[^;]*/gi, '; SameSite=None');
        };

        // 处理 Set-Cookie 头
        for (const [key, value] of response.headers.entries()) {
            if (key.toLowerCase() === 'set-cookie') {
                const rewritten = rewriteSetCookie(value.trim());
                if (rewritten) {
                    finalHeaders.append('Set-Cookie', rewritten);
                }
            }
        }

        // 添加 CORS 头
        finalHeaders.set('Access-Control-Allow-Origin', '*');
        finalHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        finalHeaders.set('Access-Control-Allow-Headers', '*');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
        });

    } catch (error) {
        // 修复8: 更详细的错误信息
        const errorInfo = {
            error: '代理请求失败',
            message: error.message || String(error),
            type: error.name || 'UnknownError',
            timestamp: new Date().toISOString()
        };

        // 根据错误类型提供更友好的提示
        let userMessage = errorInfo.message;
        if (error.message && error.message.includes('fetch failed')) {
            userMessage = '无法连接到目标网站，请检查网址是否正确，或目标网站是否可访问';
        } else if (error.message && error.message.includes('timeout')) {
            userMessage = '请求超时，目标网站响应太慢';
        } else if (error.message && error.message.includes('ENOTFOUND')) {
            userMessage = '找不到目标网站，请检查网址是否拼写正确';
        }

        return new Response(JSON.stringify({
            ...errorInfo,
            userMessage
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }
}
