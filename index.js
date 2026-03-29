#!/usr/bin/env node
/**
 * index.js — GitHub Actions 入口
 * 根据 DIGEST_MODE 环境变量决定运行日报还是周报
 */

import { spawnSync } from 'child_process';
import fs from 'fs';

// ─── 配置（全部来自 GitHub Secrets 环境变量）────────────────────────────────

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_MODEL    = process.env.ANTHROPIC_MODEL    || 'claude-sonnet-4-20250514';
const FEISHU_APP_ID      = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET  = process.env.FEISHU_APP_SECRET;
const FEISHU_CHAT_ID     = process.env.FEISHU_CHAT_ID;
const FOLLOW_BUILDERS_DIR = process.env.FOLLOW_BUILDERS_DIR || '/tmp/follow-builders/scripts';
const MODE               = process.env.DIGEST_MODE || 'daily';

// ─── Step 1：抓取数据 ────────────────────────────────────────────────────────

function fetchRawData() {
  console.log(`📡 抓取 follow-builders 数据（模式：${MODE}）...`);
  const result = spawnSync('node', ['prepare-digest.js'], {
    cwd: FOLLOW_BUILDERS_DIR,
    encoding: 'utf-8',
    timeout: 60000,
    env: process.env,
  });

  if (result.status !== 0) throw new Error(`prepare-digest.js 失败:\n${result.stderr}`);

  const stdout = result.stdout;
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) throw new Error('未返回 JSON');

  let depth = 0, jsonEnd = -1;
  for (let i = jsonStart; i < stdout.length; i++) {
    if (stdout[i] === '{') depth++;
    else if (stdout[i] === '}') { depth--; if (depth === 0) { jsonEnd = i; break; } }
  }
  const data = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
  console.log(`✅ 数据：${data.stats?.xBuilders ?? 0} 位 Builder，${data.stats?.podcastEpisodes ?? 0} 期播客`);
  return data;
}

// ─── Step 2：生成日报 ────────────────────────────────────────────────────────

async function generateDigest(feedData) {
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    timeZone: 'Asia/Shanghai',
  });
  const now = new Date();
  const weekStart = new Date(now - 6 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-CN', {
    month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai',
  });

  const xSection = (feedData.x || []).map(b => {
    const tweets = (b.tweets || []).map(t => `  - ${t.text}\n    ${t.url}`).join('\n');
    return `【${b.name}】${b.bio ? `(${b.bio})` : ''}\n${tweets}`;
  }).join('\n\n');

  const podcastSection = (feedData.podcasts || []).map(ep =>
    `【播客】${ep.name} — ${ep.title}\n链接: ${ep.url}\n节选: ${(ep.transcript || '').slice(0, 2000)}`
  ).join('\n\n');

  if (!xSection && !podcastSection) {
    console.log('⚠️  今日无新内容，跳过推送');
    return null;
  }

  const rawContent = [
    xSection && `=== X/Twitter 动态 ===\n${xSection}`,
    podcastSection && `=== 播客更新 ===\n${podcastSection}`,
  ].filter(Boolean).join('\n\n');

  const isWeekly = MODE === 'weekly';

  const system = isWeekly
    ? `你是 AI 行业动态编辑，负责整理一周的 AI Builder 动态周报。
风格：深度总结，比日报更具分析性，帮助读者理解本周 AI 行业的整体脉络。

格式规范：
- 用 Markdown，标题用 ##、###
- 链接格式：[人名 · 机构](url)：内容。不要在链接外面套粗体，不要写成 **[名字](url)**
- 不要在链接后加 (机构名) 括号，不要单独写裸 URL
- 简体中文，整体 1500-2500 字

内容结构：
1. 「本周概览」：3-5 句话总结本周 AI 行业整体趋势
2. 「播客精华 🎙️」：如有播客则提炼核心观点；无则写「本周暂无播客更新」
3. 「本周热点话题」：把所有动态按话题聚合（不超过5个话题），分析多个 Builder 的不同视角
4. 「Builder 观点精选」：本周最值得记住的 5-8 条洞察，每条附链接
5. 「本周深度洞察 💡」：4-6 条结构化洞察，每条包含「洞察点」+「为什么重要」+「对你的启发」`
    : `你是 AI 行业动态编辑，追踪顶尖 AI Builder 的最新动态。
把原始内容整理成精炼的中文日报，风格参考科技媒体，干货优先，不废话。

格式规范：
- 用 Markdown，标题用 ##、###
- 链接格式：[人名 · 机构](url)：内容。不要在链接外面套粗体，不要写成 **[名字](url)**
- 不要在链接后面再加 (机构名) 括号，不要单独一行写裸 URL
- 简体中文，整体 1000-1500 字

内容结构（按此顺序）：
1. 「今日必看 ⭐」：最重要的 3 条，每条 1 句话说明为什么值得看，附链接
2. 「播客精华 🎙️」：如有播客则提炼 3-5 个核心观点；无则写「今日暂无播客更新」
3. 「主题速览 📊」：X/Twitter 动态按主题归组（模型与技术 / 产品与工具 / 创业与思考 / 行业观察），每人 1 句话附链接
4. 「今日洞察 💡」：3-5 个结构化洞察，每条格式：洞察点一句话 + 为什么值得学 1-2 句话`;

  const userPrompt = isWeekly
    ? `以下是本周（${weekStart} 至 ${today}）的原始内容，请整理成周报：\n\n${rawContent}\n\n输出格式：\n# 🤖 AI Builders 周报 · ${weekStart} - ${today}\n\n## 📋 本周概览\n...\n\n## 🎙️ 播客精华\n...\n\n## 🔥 本周热点话题\n\n### 话题一：xxx\n...\n\n## ⭐ Builder 观点精选\n...\n\n## 💡 本周深度洞察\n...`
    : `今天是 ${today}，以下是原始内容，请整理成日报：\n\n${rawContent}\n\n输出格式：\n# 🤖 AI Builders 日报 · ${today}\n\n## ⭐ 今日必看\n...\n\n## 🎙️ 播客精华\n...\n\n## 📊 主题速览\n\n### 模型与技术\n...\n\n### 产品与工具\n...\n\n### 创业与思考\n...\n\n### 行业观察\n...\n\n## 💡 今日洞察\n\n**洞察1：xxx**\n是什么：...\n为什么值得学：...\n\n（共3-5条）`;

  console.log(`🤖 调用 LLM 整理${isWeekly ? '周报' : '日报'}...`);

  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: isWeekly ? 4000 : 2500,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) throw new Error(`LLM API 错误: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const digest = data.content.map(b => b.text || '').join('');
  console.log(`✅ ${isWeekly ? '周报' : '日报'}生成完成（${digest.length} 字）`);
  return digest;
}

// ─── Step 3：推送到飞书 ──────────────────────────────────────────────────────

async function deliver(markdown) {
  const { deliver: deliverFn } = await import('./deliver-feishu-doc.js');
  await deliverFn(markdown, MODE);
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    if (!ANTHROPIC_API_KEY) throw new Error('缺少 ANTHROPIC_API_KEY');
    if (!FEISHU_APP_ID)     throw new Error('缺少 FEISHU_APP_ID');

    const feedData = fetchRawData();
    const digest   = await generateDigest(feedData);
    if (!digest) return;
    await deliver(digest);
    console.log('🎉 完成！');
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

main();
