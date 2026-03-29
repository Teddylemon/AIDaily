#!/usr/bin/env node
/**
 * deliver-feishu-doc.js
 * 读取 Claude 整理好的 Markdown 日报，
 * 1. 创建飞书云文档
 * 2. 在群里发卡片消息（含文档链接 + 内容摘要）
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ─── 配置 ───────────────────────────────────────────────────────────────────

const ENV_PATH = path.join(process.env.HOME, '.follow-builders/.env');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const APP_ID     = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const CHAT_ID    = process.env.FEISHU_CHAT_ID;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

async function post(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

// ─── Step 1：获取 tenant_access_token ───────────────────────────────────────

async function getToken() {
  const data = await post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: APP_ID, app_secret: APP_SECRET }
  );
  if (data.code !== 0) throw new Error(`获取 token 失败: ${data.msg}`);
  return data.tenant_access_token;
}

// ─── Step 2：把 Markdown 转成飞书文档 Block 格式 ────────────────────────────

// 把一行文本解析成飞书富文本 elements（支持粗体、超链接、粗体内嵌链接）
function parseInline(line) {
  const elements = [];

  // 预处理：去掉 [text](url)(多余括号)
  const cleaned = line.replace(/(\]\([^)]+\))\([^)]*\)/g, '$1');

  // 优先匹配顺序：**[text](url)** > [text](url) > **text**
  const tokenRe = /\*\*\[([^\]]+)\]\(([^)]+)\)\*\*|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let lastIndex = 0, match;

  while ((match = tokenRe.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      elements.push({ text_run: { content: cleaned.slice(lastIndex, match.index) } });
    }

    if (match[1] !== undefined) {
      // **[text](url)** → 粗体超链接
      elements.push({ text_run: { content: match[1], text_element_style: { bold: true, link: { url: match[2] } } } });
    } else if (match[3] !== undefined) {
      // [text](url) → 超链接
      elements.push({ text_run: { content: match[3], text_element_style: { link: { url: match[4] } } } });
    } else {
      // **text** → 粗体
      elements.push({ text_run: { content: match[5], text_element_style: { bold: true } } });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < cleaned.length) {
    elements.push({ text_run: { content: cleaned.slice(lastIndex) } });
  }
  if (elements.length === 0) elements.push({ text_run: { content: cleaned } });
  return elements;
}

function markdownToBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let prevWasHeading = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // 空行：标题后面的空行直接跳过，避免间距过大
    if (!line) {
      if (!prevWasHeading) {
        blocks.push({ block_type: 2, text: { elements: [{ text_run: { content: '' } }], style: {} } });
      }
      prevWasHeading = false;
      continue;
    }

    // H1 → 飞书文档不支持子块用 H1，降级为 H2
    if (line.startsWith('# ')) {
      blocks.push({ block_type: 4, heading2: { elements: parseInline(line.slice(2)), style: {} } });
      prevWasHeading = true;
      continue;
    }

    // H2 → H3
    if (line.startsWith('## ')) {
      blocks.push({ block_type: 5, heading3: { elements: parseInline(line.slice(3)), style: {} } });
      prevWasHeading = true;
      continue;
    }

    // H3 → 粗体段落
    if (line.startsWith('### ')) {
      const els = parseInline(line.slice(4)).map(el =>
        el.text_run ? { text_run: { ...el.text_run, text_element_style: { ...(el.text_run.text_element_style||{}), bold: true } } } : el
      );
      blocks.push({ block_type: 2, text: { elements: els, style: {} } });
      prevWasHeading = true;
      continue;
    }

    prevWasHeading = false;

    // 无序列表
    if (line.match(/^[-*] /)) {
      blocks.push({ block_type: 12, bullet: { elements: parseInline(line.slice(2)), style: {} } });
      continue;
    }

    // 有序列表
    if (line.match(/^\d+\. /)) {
      blocks.push({ block_type: 13, ordered: { elements: parseInline(line.replace(/^\d+\. /, '')), style: {} } });
      continue;
    }

    // 普通段落
    blocks.push({ block_type: 2, text: { elements: parseInline(line), style: {} } });
  }

  return blocks;
}

// ─── Step 3：创建飞书云文档 ─────────────────────────────────────────────────

async function createDoc(token, title, markdown) {
  const blocks = markdownToBlocks(markdown);

  const data = await post(
    'https://open.feishu.cn/open-apis/docx/v1/documents',
    {
      title,
      folder_token: '', // 空 = 存到应用根目录
    },
    token
  );

  if (data.code !== 0) throw new Error(`创建文档失败: ${data.msg}`);

  const docToken = data.data.document.document_id;
  const docUrl   = `https://feishu.cn/docx/${docToken}`;

  // 清理 blocks：过滤掉可能导致 field validation failed 的问题
  const cleanBlocks = blocks.map(block => {
    // 深度清理每个 block 的 elements，去掉空 url、空 content
    const cleanElements = (elements) => {
      if (!elements) return elements;
      return elements
        .map(el => {
          if (!el.text_run) return el;
          const tr = { ...el.text_run };
          // 过滤掉 content 为空或纯空格的 element
          if (!tr.content && tr.content !== 0) return null;
          if (typeof tr.content === 'string' && !tr.content.trim()) return null;
          // 清理 text_element_style
          if (tr.text_element_style) {
            const style = { ...tr.text_element_style };
            // link.url 不能为空
            if (style.link && !style.link.url) delete style.link;
            // 去掉空的 style 对象
            if (Object.keys(style).length === 0) delete tr.text_element_style;
            else tr.text_element_style = style;
          }
          return { text_run: tr };
        })
        .filter(Boolean);
    };

    const b = { block_type: block.block_type };
    if (block.text)    b.text    = { ...block.text,    elements: cleanElements(block.text.elements) };
    if (block.heading1) b.heading1 = { ...block.heading1, elements: cleanElements(block.heading1.elements) };
    if (block.heading2) b.heading2 = { ...block.heading2, elements: cleanElements(block.heading2.elements) };
    if (block.heading3) b.heading3 = { ...block.heading3, elements: cleanElements(block.heading3.elements) };
    if (block.bullet)  b.bullet  = { ...block.bullet,  elements: cleanElements(block.bullet.elements) };
    if (block.ordered) b.ordered = { ...block.ordered, elements: cleanElements(block.ordered.elements) };
    return b;
  });

  // 分批写入（每批最多 50 个），避免单次请求过大
  console.log(`📝 写入 ${cleanBlocks.length} 个 blocks（分批）...`);
  const BATCH = 50;
  for (let i = 0; i < cleanBlocks.length; i += BATCH) {
    const batch = cleanBlocks.slice(i, i + BATCH);
    const writeResult = await post(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docToken}/blocks/${docToken}/children`,
      { children: batch, index: i },
      token
    );
    if (writeResult.code !== 0) {
      console.error(`❌ 第 ${i}-${i+batch.length} 批写入失败:`, writeResult.code, writeResult.msg);
      // 打印第一个 block 帮助调试
      console.error('问题 batch 第一个 block:', JSON.stringify(batch[0], null, 2));
    } else {
      console.log(`✅ 第 ${i+1}-${i+batch.length} 批写入成功`);
    }
  }

  // 设置链接分享权限为「组织内获得链接的人可查看」
  const permResult = await fetch(
    `https://open.feishu.cn/open-apis/drive/v1/permissions/${docToken}/public?type=docx`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ link_share_entity: 'tenant_readable' }),
    }
  ).then(r => r.json());
  if (permResult.code !== 0) {
    console.warn('⚠️  权限设置返回:', permResult.code, permResult.msg);
  } else {
    console.log('✅ 文档权限已设置为组织内可见');
  }

  return { docToken, docUrl };
}

// ─── Step 4：在群里发卡片消息 ────────────────────────────────────────────────

async function sendCard(token, docUrl, title, summary) {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: summary },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📄 查看完整日报' },
            type: 'primary',
            url: docUrl,
          },
        ],
      },
    ],
  };

  const data = await post(
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: CHAT_ID,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
    token
  );

  if (data.code !== 0) throw new Error(`发送消息失败: ${data.msg}`);
}

// ─── 提取摘要（取日报里「今日洞察」部分，没有就取前 200 字）──────────────────

function extractSummary(markdown) {
  const insightMatch = markdown.match(/##\s*[💡🔍✨]?\s*今日洞察\n+([\s\S]+?)(\n##|$)/);
  if (insightMatch) return insightMatch[1].trim().slice(0, 300);
  // 取正文前 200 字（跳过标题行）
  const body = markdown.replace(/^#.+\n/, '').trim();
  return body.slice(0, 200) + (body.length > 200 ? '...' : '');
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

// ─── 导出核心函数供 run-digest.js 直接调用 ────────────────────────────────

export async function deliver(markdown, mode = 'daily') {
  if (!markdown || !markdown.trim()) {
    console.log('⚠️  无内容，跳过推送');
    return;
  }

  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    throw new Error('缺少环境变量，请检查 ~/.follow-builders/.env');
  }

  const now = new Date();
  const today = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  const weekStart = new Date(now - 6 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });

  const title = mode === 'weekly'
    ? `AI Builders 周报 · ${weekStart} - ${today}`
    : `AI Builders 日报 · ${today}`;
  const summary = extractSummary(markdown);

  console.log('🔑 获取访问令牌...');
  const token = await getToken();

  console.log('📄 创建飞书云文档...');
  const { docUrl } = await createDoc(token, title, markdown);
  console.log('✅ 文档已创建:', docUrl);

  console.log('📨 发送群通知...');
  await sendCard(token, docUrl, `🤖 ${title}`, summary);
  console.log('✅ 群通知已发送！');
}

// 支持直接命令行运行：node deliver-feishu-doc.js --file /tmp/xxx.md
async function main() {
  const fileFlag = process.argv.indexOf('--file');
  let markdown = '';
  if (fileFlag !== -1 && process.argv[fileFlag + 1]) {
    markdown = fs.readFileSync(process.argv[fileFlag + 1], 'utf-8');
  } else {
    markdown = fs.readFileSync('/dev/stdin', 'utf-8');
  }
  await deliver(markdown);
}

// 只有直接运行时才执行 main
if (process.argv[1] && process.argv[1].endsWith('deliver-feishu-doc.js')) {
  main().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
