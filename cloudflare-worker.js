/**
 * Cloudflare Worker — 飞书事件接收器
 *
 * 部署到 Cloudflare Workers（永久免费）
 * 接收飞书群消息事件，识别 /daily 和 /weekly 指令，触发 GitHub Actions
 *
 * 需要配置的环境变量（在 Cloudflare Workers 设置里）：
 *   FEISHU_APP_VERIFICATION_TOKEN  飞书应用的 Verification Token
 *   FEISHU_APP_ENCRYPT_KEY         飞书应用的 Encrypt Key（可选）
 *   GITHUB_TOKEN                   GitHub Personal Access Token（需要 actions:write 权限）
 *   GITHUB_OWNER                   GitHub 用户名，如 Teddylemon
 *   GITHUB_REPO                    仓库名，如 AIDaily
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // 飞书验证 URL 挑战
    if (body.challenge) {
      return Response.json({ challenge: body.challenge });
    }

    // 验证 Token
    if (body.token !== env.FEISHU_APP_VERIFICATION_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 处理消息事件
    const event = body.event;
    if (!event || event.message?.chat_type !== 'group') {
      return new Response('OK');
    }

    // 解析消息文字
    let text = '';
    try {
      const content = JSON.parse(event.message.content || '{}');
      text = (content.text || '').trim();
    } catch {
      return new Response('OK');
    }

    // 响应指令
    let mode = null;
    if (text === '/daily')  mode = 'daily';
    if (text === '/weekly') mode = 'weekly';

    if (!mode) return new Response('OK');

    // 触发 GitHub Actions
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/digest.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({
            ref: 'main',
            inputs: { mode },
          }),
        }
      );

      if (resp.ok) {
        console.log(`✅ 已触发 GitHub Actions：${mode}`);
      } else {
        const err = await resp.text();
        console.error('GitHub Actions 触发失败:', err);
      }
    } catch (err) {
      console.error('触发出错:', err.message);
    }

    return new Response('OK');
  },
};
