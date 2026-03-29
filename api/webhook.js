/**
 * api/webhook.js — Vercel Serverless Function
 * 接收飞书群消息事件，识别 /daily 和 /weekly 指令，触发 GitHub Actions
 *
 * 环境变量（在 Vercel 项目设置里配置）：
 *   FEISHU_APP_VERIFICATION_TOKEN
 *   GITHUB_TOKEN
 *   GITHUB_OWNER
 *   GITHUB_REPO
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  const body = req.body;
  if (!body) return res.status(400).send('Bad Request');

  // 飞书验证 URL 挑战（最先处理）
  if (body.challenge) {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 验证 Token
  const verifyToken = process.env.FEISHU_APP_VERIFICATION_TOKEN;
  if (verifyToken && body.token !== verifyToken) {
    return res.status(401).send('Unauthorized');
  }

  // 处理消息事件
  const event = body.event;
  if (!event || event.message?.chat_type !== 'group') {
    return res.status(200).send('OK');
  }

  // 解析消息文字
  let text = '';
  try {
    const content = JSON.parse(event.message.content || '{}');
    text = (content.text || '').trim();
  } catch {
    return res.status(200).send('OK');
  }

  // 识别指令
  let mode = null;
  if (text === '/daily')  mode = 'daily';
  if (text === '/weekly') mode = 'weekly';
  if (!mode) return res.status(200).send('OK');

  // 异步触发 GitHub Actions（不等待结果，立即返回 200 避免飞书重试）
  res.status(200).send('OK');

  try {
    const owner = process.env.GITHUB_OWNER;
    const repo  = process.env.GITHUB_REPO;
    const token = process.env.GITHUB_TOKEN;

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/digest.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'main', inputs: { mode } }),
      }
    );

    if (resp.ok) {
      console.log(`✅ 已触发 GitHub Actions：${mode}`);
    } else {
      console.error('GitHub Actions 触发失败:', await resp.text());
    }
  } catch (err) {
    console.error('触发出错:', err.message);
  }
}
