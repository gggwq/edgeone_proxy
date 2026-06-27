# 代理代码修复指南

## 问题1：无法解码原始数据

### 原因
目标网站返回的内容编码（gzip/deflate）没有正确处理，或者二进制文件（图片、视频）传输时出现问题。

### 修复方法
在 `proxy.js` 的响应处理部分，添加内容类型检测：

```javascript
// 在返回响应之前，添加这段代码
const contentType = response.headers.get('content-type') || '';

const isBinary = contentType.includes('image') ||
                 contentType.includes('video') ||
                 contentType.includes('audio') ||
                 contentType.includes('application/octet-stream');

if (isBinary) {
    // 二进制内容：直接返回，不修改
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: finalHeaders
    });
}
```

## 问题2：链接无效

### 原因
URL 参数没有正确编码或解码，导致目标网址解析失败。

### 修复方法
在处理 URL 参数时，添加解码逻辑：

```javascript
// 在获取 url 参数后，添加这段代码
let targetUrlParam = requestUrl.searchParams.get('url');

// 解码 URL（如果它是编码的）
try {
    if (targetUrlParam.includes('%')) {
        targetUrlParam = decodeURIComponent(targetUrlParam);
    }
    // 自动补全协议
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
    return new Response('无效的 URL: ' + targetUrlParam, { status: 400 });
}
```

## 完整修复步骤

1. **备份原文件**
   ```bash
   cp functions/proxy.js functions/proxy.js.backup
   ```

2. **应用修复**
   - 方法A：直接使用我提供的 `proxy-fixed.js`（已包含所有修复）
   - 方法B：手动修改 `proxy.js`，应用上述两个修复

3. **重新部署**
   - 提交代码到 Git
   - EdgeOne Pages 会自动重新部署

## 测试验证

部署后，测试以下场景：

### 测试1：普通网页
```
/proxy?url=https://www.google.com
```

### 测试2：带中文的网址（需要编码）
```
/proxy?url=https%3A%2F%2Fwww.baidu.com%2Fs%3Fwd%3D测试
```

### 测试3：图片等二进制内容
```
/proxy?url=https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png
```

### 测试4：缺少协议的网址
修改前端页面，让它可以接受 `example.com` 这样的输入（代码会自动补全为 `https://example.com`）

## 如果问题仍然存在

1. **检查 EdgeOne 日志**
   - 登录腾讯云控制台
   - 查看 Pages 函数的运行日志
   - 看是否有更详细的错误信息

2. **测试目标网站是否可访问**
   - 有些网站有反代理机制（如 Cloudflare 防护）
   - 可以尝试代理简单的、没有防护的网站

3. **检查网络连接**
   - EdgeOne 边缘节点可能无法访问某些被屏蔽的网站
   - 尝试不同的目标网站

## 常见错误及解决方案

| 错误信息 | 原因 | 解决方案 |
|---------|------|---------|
| 无法解码原始数据 | 压缩内容未正确处理 | 应用上述修复方法1 |
| 链接无效 | URL 编码问题 | 应用上述修复方法2 |
| 代理错误：fetch failed | 目标网站不可访问 | 检查目标网址是否正确 |
| 超时 | 目标网站响应慢 | EdgeOne 有30秒超时限制，无法解决 |
| 403 Forbidden | 目标网站有反代理机制 | 需要更高级的代理（如处理 JS 质询） |
