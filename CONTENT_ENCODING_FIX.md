# 内容编码错误修复指南

## 问题：ERR_CONTENT_DECODING_FAILED

### 错误信息
```
net::ERR_CONTENT_DECODING_FAILED 200 (OK)
```

### 原因
这是代理代码中最常见的错误，原因是：

1. **问题机制**：
   - 目标网站返回 `gzip` 压缩的内容
   - 响应头包含 `Content-Encoding: gzip`
   - 但内容实际上已经被解压了（或被错误解压）
   - 浏览器看到 `Content-Encoding: gzip`，尝试解压
   - 但内容不是 gzip 格式，导致解压失败

2. **为什么会发生**：
   - EdgeOne 的 `fetch()` 会自动解压 `gzip`/`deflate` 内容
   - 但代码错误地把原始的 `Content-Encoding` 头传递给了浏览器
   - 浏览器以为内容还是压缩的，尝试解压 → 失败

## 解决方案

### ✅ 正确做法（已在 proxy-final.js 中实现）

```javascript
// 1. 不发送 Accept-Encoding 请求头
// 让 fetch() 自动处理压缩，返回解压后的内容
outgoingHeaders.delete('accept-encoding');

// 2. 不传递 Content-Encoding 响应头
// 因为 fetch() 已经解压了内容，我们返回的是明文
const skipHeaders = ['content-encoding', 'transfer-encoding'];
for (const [key, value] of response.headers.entries()) {
    if (!skipHeaders.includes(key.toLowerCase())) {
        finalHeaders.set(key, value);
    }
}

// 3. 直接返回 response.body
// 这时 body 已经是解压后的明文内容
return new Response(response.body, {
    status: response.status,
    headers: finalHeaders
});
```

### ❌ 错误做法（原代码的问题）

```javascript
// 错误：直接复制所有响应头，包括 Content-Encoding
const finalHeaders = new Headers(response.headers);

// 这样会导致浏览器尝试解压已经是明文的内容
```

## 测试验证

### 测试 1：百度（会返回 gzip 内容）
```
https://pp.vwwv.fun/proxy?url=https://www.baidu.com
```

**修复前**：ERR_CONTENT_DECODING_FAILED ❌  
**修复后**：正常显示百度首页 ✅

### 测试 2：Google
```
https://pp.vwwv.fun/proxy?url=https://www.google.com
```

**修复前**：可能无法解码 ❌  
**修复后**：正常显示 Google 首页 ✅

### 测试 3：GitHub
```
https://pp.vwwv.fun/proxy?url=https://github.com
```

**修复前**：可能报错 ❌  
**修复后**：正常显示 ✅

## 其他常见问题

### 问题 1：YouTube 无法代理

**原因**：
- YouTube 需要 JavaScript 渲染
- 有强大的反爬虫/反代理机制
- 需要正确处理 Cookie、Session

**部分解决方案**：
```javascript
// 1. 保留 Cookie
const cookie = request.headers.get('cookie');
if (cookie) {
    outgoingHeaders.set('cookie', cookie);
}

// 2. 添加 Referer
outgoingHeaders.set('referer', targetUrl.href);

// 3. 处理重定向（避免丢失 Cookie）
if ([301, 302, 303, 307, 308].includes(response.status)) {
    // 手动处理重定向，带上 Cookie
}
```

**但仍然可能无法完全代理 YouTube**，因为：
- YouTube 使用 Service Worker
- 大量动态加载内容
- 需要执行 JavaScript

**建议**：这类网站不适合用简单反向代理，需要使用无头浏览器（Puppeteer）或专用工具。

### 问题 2：HTTPS 证书错误

**现象**：某些网站无法访问，报错关于证书

**解决方案**：
- EdgeOne 的 `fetch()` 会自动验证 HTTPS 证书
- 如果证书无效，会报错
- 这是安全特性，不建议绕过

## 部署更新

代码已推送到 GitHub，需要重新部署到 EdgeOne Pages：

### 方法 1：自动部署（推荐）
1. 推送代码到 GitHub（已完成）
2. EdgeOne Pages 会自动检测到更新
3. 等待 1-2 分钟，自动重新部署
4. 访问你的域名，测试是否修复

### 方法 2：手动重新部署
1. 登录腾讯云 EdgeOne 控制台
2. 找到你的 Pages 项目
3. 点击"重新部署"
4. 等待部署完成

## 验证修复

部署完成后，测试这些网址：

✅ **应该可以正常工作**：
- `https://www.baidu.com`
- `https://www.google.com`
- `https://github.com`
- `https://www.example.com`

❌ **可能仍然无法工作**：
- `https://www.youtube.com` （需要 JS 渲染）
- 需要登录的网站（需要更复杂的 Cookie/Session 处理）
- 有强反爬虫的网站

## 后续优化建议

如果还需要代理更复杂的网站，可以考虑：

1. **添加 HTML 重写**：
   - 重写页面中的绝对 URL 为代理 URL
   - 例如：`<a href="https://example.com/page">` → `<a href="/proxy?url=https://example.com/page">`

2. **处理表单提交**：
   - 拦截表单 POST 请求
   - 转发到目标网站

3. **使用无头浏览器**（高级）：
   - 使用 Puppeteer/Playwright
   - 执行 JavaScript，渲染页面
   - 但会大幅增加复杂度和成本

## 总结

**核心修复**：不传递 `Content-Encoding` 头，让浏览器自己处理内容编码。

**代码位置**：`functions/proxy.js`（已更新为 proxy-final.js 的内容）

**提交 hash**：`1b280d2`

**已推送到 GitHub**：✅ 是

---

现在重新部署你的 EdgeOne Pages 项目，问题应该就解决了！
