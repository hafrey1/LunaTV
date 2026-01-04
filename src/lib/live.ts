/* eslint-disable no-constant-condition */

import { getConfig } from "@/lib/config";
import { db } from "@/lib/db";

const defaultUA = 'AptvPlayer/1.4.10'

export interface LiveChannels {
  channelNumber: number;
  channels: {
    id: string;
    tvgId: string;
    name: string;
    logo: string;
    group: string;
    url: string;
  }[];
  epgUrl: string;
  epgs: {
    [key: string]: {
      start: string;
      end: string;
      title: string;
    }[];
  };
}

const cachedLiveChannels: { [key: string]: LiveChannels } = {};

export function deleteCachedLiveChannels(key: string) {
  delete cachedLiveChannels[key];
}

export async function getCachedLiveChannels(key: string): Promise<LiveChannels | null> {
  if (!cachedLiveChannels[key]) {
    const config = await getConfig();
    const liveInfo = config.LiveConfig?.find(live => live.key === key);
    if (!liveInfo) {
      return null;
    }
    const channelNum = await refreshLiveChannels(liveInfo);
    if (channelNum === 0) {
      return null;
    }
    liveInfo.channelNumber = channelNum;
    await db.saveAdminConfig(config);
  }
  return cachedLiveChannels[key] || null;
}

export async function refreshLiveChannels(liveInfo: {
  key: string;
  name: string;
  url: string;
  ua?: string;
  epg?: string;
  from: 'config' | 'custom';
  channelNumber?: number;
  disabled?: boolean;
}): Promise<number> {
  if (cachedLiveChannels[liveInfo.key]) {
    delete cachedLiveChannels[liveInfo.key];
  }
  const ua = liveInfo.ua || defaultUA;
  const response = await fetch(liveInfo.url, {
    headers: {
      'User-Agent': ua,
    },
  });
  const data = await response.text();
  const result = parseM3U(liveInfo.key, data);
  const epgUrl = liveInfo.epg || result.tvgUrl;
  const epgs = await parseEpg(
    epgUrl,
    liveInfo.ua || defaultUA,
    result.channels.map(channel => channel.tvgId).filter(tvgId => tvgId),
    result.channels // 传入完整的频道列表用于名称匹配
  );
  cachedLiveChannels[liveInfo.key] = {
    channelNumber: result.channels.length,
    channels: result.channels,
    epgUrl: epgUrl,
    epgs: epgs,
  };
  return result.channels.length;
}

/**
 * 清理频道名称用于匹配
 * 移除常见前缀、后缀、特殊字符等
 */
function normalizeChannelName(name: string): string {
  return name
    // 移除前缀如 [TW-I]、[HK]、01、02 等
    .replace(/^\[.*?\]\s*/g, '')
    .replace(/^\d+\s+/g, '')
    // 移除后缀如 (a)、(b)、HD、4K 等
    .replace(/\s*\([a-z0-9]+\)\s*/gi, '')
    .replace(/\s*(HD|4K|FHD|UHD)\s*/gi, '')
    // 移除多余空格
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface EpgDebugInfo {
  nameToTvgIdSample: Array<{ normalizedName: string; key: string }>;
  epgNameToChannelIdSample: Array<{ normalizedName: string; channelId: string }>;
  totalEpgChannels: number;
  totalM3uChannelMappings: number;
  tvgIdMatchCount: number;
  nameMatchCount: number;
  nameMatchDetails: Array<{ epgName: string; m3uKey: string }>;
}

async function parseEpg(
  epgUrl: string,
  ua: string,
  tvgIds: string[],
  channels?: { tvgId: string; name: string }[]
): Promise<{
  [key: string]: {
    start: string;
    end: string;
    title: string;
  }[]
}> {
  if (!epgUrl) {
    return {};
  }

  const tvgs = new Set(tvgIds);
  const result: { [key: string]: { start: string; end: string; title: string }[] } = {};

  // 构建频道名称到 tvgId 的映射（用于后备匹配）
  const nameToTvgId = new Map<string, string>();
  if (channels) {
    for (const channel of channels) {
      const normalizedName = normalizeChannelName(channel.name);
      if (normalizedName) {
        // 如果有 tvg-id 就用 tvg-id，否则用频道名称作为 key
        const key = channel.tvgId || channel.name;
        nameToTvgId.set(normalizedName, key);
      }
    }
    console.log(`[EPG] 构建了 ${nameToTvgId.size} 个频道名称映射`);
  }

  // 存储 EPG 频道名称到 channel ID 的映射（用于名称匹配）
  const epgNameToChannelId = new Map<string, string>();

  try {
    const response = await fetch(epgUrl, {
      headers: {
        'User-Agent': ua,
      },
    });
    if (!response.ok) {
      return {};
    }

    // 使用 ReadableStream 逐行处理，避免将整个文件加载到内存
    const reader = response.body?.getReader();
    if (!reader) {
      return {};
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let currentTvgId = '';
    let currentProgram: { start: string; end: string; title: string } | null = null;
    let shouldSkipCurrentProgram = false;
    let isFirstPass = true; // 第一遍：收集 channel 信息

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // 保留最后一行（可能不完整）
      buffer = lines.pop() || '';

      // 处理完整的行
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // 第一步：解析 <channel> 标签，建立名称映射
        if (isFirstPass && trimmedLine.startsWith('<channel')) {
          const channelIdMatch = trimmedLine.match(/id="([^"]*)"/);
          const channelId = channelIdMatch ? channelIdMatch[1] : '';

          // 查找 display-name
          const displayNameMatch = trimmedLine.match(/<display-name[^>]*>(.*?)<\/display-name>/);
          if (channelId && displayNameMatch) {
            const displayName = displayNameMatch[1];
            const normalizedDisplayName = normalizeChannelName(displayName);
            epgNameToChannelId.set(normalizedDisplayName, channelId);
          }
        }

        // 解析 <programme> 标签
        if (trimmedLine.startsWith('<programme')) {
          isFirstPass = false; // 遇到 programme 标签，结束第一遍扫描

          // 提取 channel ID
          const channelIdMatch = trimmedLine.match(/channel="([^"]*)"/);
          const epgChannelId = channelIdMatch ? channelIdMatch[1] : '';

          // 提取开始时间
          const startMatch = trimmedLine.match(/start="([^"]*)"/);
          const start = startMatch ? startMatch[1] : '';

          // 提取结束时间
          const endMatch = trimmedLine.match(/stop="([^"]*)"/);
          const end = endMatch ? endMatch[1] : '';

          if (epgChannelId && start && end) {
            currentProgram = { start, end, title: '' };

            // 优先使用 tvg-id 精确匹配（保留原有逻辑）
            if (tvgs.has(epgChannelId)) {
              currentTvgId = epgChannelId;
              shouldSkipCurrentProgram = false;
            } else {
              // 后备方案：使用名称匹配
              // 从 epgNameToChannelId 找到 EPG 频道名称
              let matched = false;
              for (const [epgNormalizedName, epgChanId] of epgNameToChannelId.entries()) {
                if (epgChanId === epgChannelId) {
                  // 在我们的频道列表中查找匹配的名称
                  const matchedTvgId = nameToTvgId.get(epgNormalizedName);
                  if (matchedTvgId) {
                    currentTvgId = matchedTvgId;
                    shouldSkipCurrentProgram = false;
                    matched = true;
                    console.log(`[EPG] 名称匹配成功: "${epgNormalizedName}" -> ${matchedTvgId}`);
                    break;
                  }
                }
              }

              if (!matched) {
                shouldSkipCurrentProgram = true;
              }
            }
          }
        }
        // 解析 <title> 标签 - 只有在需要解析当前节目时才处理
        else if (trimmedLine.startsWith('<title') && currentProgram && !shouldSkipCurrentProgram) {
          // 处理带有语言属性的title标签，如 <title lang="zh">远方的家2025-60</title>
          const titleMatch = trimmedLine.match(/<title(?:\s+[^>]*)?>(.*?)<\/title>/);
          if (titleMatch && currentProgram) {
            currentProgram.title = titleMatch[1];

            // 保存节目信息
            if (!result[currentTvgId]) {
              result[currentTvgId] = [];
            }
            result[currentTvgId].push({ ...currentProgram });

            currentProgram = null;
          }
        }
        // 处理 </programme> 标签
        else if (trimmedLine === '</programme>') {
          currentProgram = null;
          currentTvgId = '';
          shouldSkipCurrentProgram = false; // 重置跳过标志
        }
      }
    }
  } catch (error) {
    // ignore
  }

  return result;
}

// 新增诊断版本的 parseEpg，返回详细的调试信息
export async function parseEpgWithDebug(
  epgUrl: string,
  ua: string,
  tvgIds: string[],
  channels?: { tvgId: string; name: string }[]
): Promise<{
  epgs: {
    [key: string]: {
      start: string;
      end: string;
      title: string;
    }[]
  };
  debug: EpgDebugInfo;
}> {
  const debugInfo: EpgDebugInfo = {
    nameToTvgIdSample: [],
    epgNameToChannelIdSample: [],
    totalEpgChannels: 0,
    totalM3uChannelMappings: 0,
    tvgIdMatchCount: 0,
    nameMatchCount: 0,
    nameMatchDetails: [],
  };

  if (!epgUrl) {
    return { epgs: {}, debug: debugInfo };
  }

  const tvgs = new Set(tvgIds);
  const result: { [key: string]: { start: string; end: string; title: string }[] } = {};

  // 构建频道名称到 tvgId 的映射（用于后备匹配）
  const nameToTvgId = new Map<string, string>();
  if (channels) {
    for (const channel of channels) {
      const normalizedName = normalizeChannelName(channel.name);
      if (normalizedName) {
        // 如果有 tvg-id 就用 tvg-id，否则用频道名称作为 key
        const key = channel.tvgId || channel.name;
        nameToTvgId.set(normalizedName, key);
      }
    }
    debugInfo.totalM3uChannelMappings = nameToTvgId.size;
    // 采样前 10 个
    debugInfo.nameToTvgIdSample = Array.from(nameToTvgId.entries())
      .slice(0, 10)
      .map(([normalizedName, key]) => ({ normalizedName, key }));
  }

  // 存储 EPG 频道名称到 channel ID 的映射（用于名称匹配）
  const epgNameToChannelId = new Map<string, string>();

  try {
    const response = await fetch(epgUrl, {
      headers: {
        'User-Agent': ua,
      },
    });
    if (!response.ok) {
      return { epgs: {}, debug: debugInfo };
    }

    // 使用 ReadableStream 逐行处理，避免将整个文件加载到内存
    const reader = response.body?.getReader();
    if (!reader) {
      return { epgs: {}, debug: debugInfo };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let currentTvgId = '';
    let currentProgram: { start: string; end: string; title: string } | null = null;
    let shouldSkipCurrentProgram = false;
    let isFirstPass = true; // 第一遍：收集 channel 信息

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // 保留最后一行（可能不完整）
      buffer = lines.pop() || '';

      // 处理完整的行
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // 第一步：解析 <channel> 标签，建立名称映射
        if (isFirstPass && trimmedLine.startsWith('<channel')) {
          const channelIdMatch = trimmedLine.match(/id="([^"]*)"/);
          const channelId = channelIdMatch ? channelIdMatch[1] : '';

          // 查找 display-name
          const displayNameMatch = trimmedLine.match(/<display-name[^>]*>(.*?)<\/display-name>/);
          if (channelId && displayNameMatch) {
            const displayName = displayNameMatch[1];
            const normalizedDisplayName = normalizeChannelName(displayName);
            epgNameToChannelId.set(normalizedDisplayName, channelId);
          }
        }

        // 解析 <programme> 标签
        if (trimmedLine.startsWith('<programme')) {
          isFirstPass = false; // 遇到 programme 标签，结束第一遍扫描

          // 提取 channel ID
          const channelIdMatch = trimmedLine.match(/channel="([^"]*)"/);
          const epgChannelId = channelIdMatch ? channelIdMatch[1] : '';

          // 提取开始时间
          const startMatch = trimmedLine.match(/start="([^"]*)"/);
          const start = startMatch ? startMatch[1] : '';

          // 提取结束时间
          const endMatch = trimmedLine.match(/stop="([^"]*)"/);
          const end = endMatch ? endMatch[1] : '';

          if (epgChannelId && start && end) {
            currentProgram = { start, end, title: '' };

            // 优先使用 tvg-id 精确匹配（保留原有逻辑）
            if (tvgs.has(epgChannelId)) {
              currentTvgId = epgChannelId;
              shouldSkipCurrentProgram = false;
              debugInfo.tvgIdMatchCount++;
            } else {
              // 后备方案：使用名称匹配
              // 从 epgNameToChannelId 找到 EPG 频道名称
              let matched = false;
              for (const [epgNormalizedName, epgChanId] of epgNameToChannelId.entries()) {
                if (epgChanId === epgChannelId) {
                  // 在我们的频道列表中查找匹配的名称
                  const matchedTvgId = nameToTvgId.get(epgNormalizedName);
                  if (matchedTvgId) {
                    currentTvgId = matchedTvgId;
                    shouldSkipCurrentProgram = false;
                    matched = true;
                    debugInfo.nameMatchCount++;
                    // 只记录前 10 个名称匹配详情
                    if (debugInfo.nameMatchDetails.length < 10) {
                      debugInfo.nameMatchDetails.push({
                        epgName: epgNormalizedName,
                        m3uKey: matchedTvgId,
                      });
                    }
                    break;
                  }
                }
              }

              if (!matched) {
                shouldSkipCurrentProgram = true;
              }
            }
          }
        }
        // 解析 <title> 标签 - 只有在需要解析当前节目时才处理
        else if (trimmedLine.startsWith('<title') && currentProgram && !shouldSkipCurrentProgram) {
          // 处理带有语言属性的title标签，如 <title lang="zh">远方的家2025-60</title>
          const titleMatch = trimmedLine.match(/<title(?:\s+[^>]*)?>(.*?)<\/title>/);
          if (titleMatch && currentProgram) {
            currentProgram.title = titleMatch[1];

            // 保存节目信息
            if (!result[currentTvgId]) {
              result[currentTvgId] = [];
            }
            result[currentTvgId].push({ ...currentProgram });

            currentProgram = null;
          }
        }
        // 处理 </programme> 标签
        else if (trimmedLine === '</programme>') {
          currentProgram = null;
          currentTvgId = '';
          shouldSkipCurrentProgram = false; // 重置跳过标志
        }
      }
    }

    // 在解析完成后，设置 EPG 频道总数和采样
    debugInfo.totalEpgChannels = epgNameToChannelId.size;
    debugInfo.epgNameToChannelIdSample = Array.from(epgNameToChannelId.entries())
      .slice(0, 10)
      .map(([normalizedName, channelId]) => ({ normalizedName, channelId }));

  } catch (error) {
    // ignore
  }

  return { epgs: result, debug: debugInfo };
}

/**
 * 解析M3U文件内容，提取频道信息
 * @param m3uContent M3U文件的内容字符串
 * @returns 频道信息数组
 */
export function parseM3U(sourceKey: string, m3uContent: string): {
  tvgUrl: string;
  channels: {
    id: string;
    tvgId: string;
    name: string;
    logo: string;
    group: string;
    url: string;
  }[];
} {
  const channels: {
    id: string;
    tvgId: string;
    name: string;
    logo: string;
    group: string;
    url: string;
  }[] = [];

  const lines = m3uContent.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  let tvgUrl = '';
  let channelIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检查是否是 #EXTM3U 行，提取 tvg-url
    if (line.startsWith('#EXTM3U')) {
      // 支持两种格式：x-tvg-url 和 url-tvg
      const tvgUrlMatch = line.match(/(?:x-tvg-url|url-tvg)="([^"]*)"/);
      tvgUrl = tvgUrlMatch ? tvgUrlMatch[1].split(',')[0].trim() : '';
      continue;
    }

    // 检查是否是 #EXTINF 行
    if (line.startsWith('#EXTINF:')) {
      // 提取 tvg-id
      const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
      const tvgId = tvgIdMatch ? tvgIdMatch[1] : '';

      // 提取 tvg-name
      const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
      const tvgName = tvgNameMatch ? tvgNameMatch[1] : '';

      // 提取 tvg-logo
      const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/);
      const logo = tvgLogoMatch ? tvgLogoMatch[1] : '';

      // 提取 group-title
      const groupTitleMatch = line.match(/group-title="([^"]*)"/);
      const group = groupTitleMatch ? groupTitleMatch[1] : '无分组';

      // 提取标题（#EXTINF 行最后的逗号后面的内容）
      const titleMatch = line.match(/,([^,]*)$/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // 优先使用 tvg-name，如果没有则使用标题
      const name = title || tvgName || '';

      // 检查下一行是否是URL
      if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        const url = lines[i + 1];

        // 只有当有名称和URL时才添加到结果中
        if (name && url) {
          channels.push({
            id: `${sourceKey}-${channelIndex}`,
            tvgId,
            name,
            logo,
            group,
            url
          });
          channelIndex++;
        }

        // 跳过下一行，因为已经处理了
        i++;
      }
    }
  }

  return { tvgUrl, channels };
}

// utils/urlResolver.js
export function resolveUrl(baseUrl: string, relativePath: string) {
  try {
    // 如果已经是完整的 URL，直接返回
    if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
      return relativePath;
    }

    // 如果是协议相对路径 (//example.com/path)
    if (relativePath.startsWith('//')) {
      const baseUrlObj = new URL(baseUrl);
      return `${baseUrlObj.protocol}${relativePath}`;
    }

    // 使用 URL 构造函数处理相对路径
    const baseUrlObj = new URL(baseUrl);
    const resolvedUrl = new URL(relativePath, baseUrlObj);
    return resolvedUrl.href;
  } catch (error) {
    // 降级处理
    return fallbackUrlResolve(baseUrl, relativePath);
  }
}

function fallbackUrlResolve(baseUrl: string, relativePath: string) {
  // 移除 baseUrl 末尾的文件名，保留目录路径
  let base = baseUrl;
  if (!base.endsWith('/')) {
    base = base.substring(0, base.lastIndexOf('/') + 1);
  }

  // 处理不同类型的相对路径
  if (relativePath.startsWith('/')) {
    // 绝对路径 (/path/to/file)
    const urlObj = new URL(base);
    return `${urlObj.protocol}//${urlObj.host}${relativePath}`;
  } else if (relativePath.startsWith('../')) {
    // 上级目录相对路径 (../path/to/file)
    const segments = base.split('/').filter(s => s);
    const relativeSegments = relativePath.split('/').filter(s => s);

    for (const segment of relativeSegments) {
      if (segment === '..') {
        segments.pop();
      } else if (segment !== '.') {
        segments.push(segment);
      }
    }

    const urlObj = new URL(base);
    return `${urlObj.protocol}//${urlObj.host}/${segments.join('/')}`;
  } else {
    // 当前目录相对路径 (file.ts 或 ./file.ts)
    const cleanRelative = relativePath.startsWith('./') ? relativePath.slice(2) : relativePath;
    return base + cleanRelative;
  }
}

// 获取 M3U8 的基础 URL
export function getBaseUrl(m3u8Url: string) {
  try {
    const url = new URL(m3u8Url);
    // 如果 URL 以 .m3u8 结尾，移除文件名
    if (url.pathname.endsWith('.m3u8')) {
      url.pathname = url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1);
    } else if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
    }
    return url.protocol + "//" + url.host + url.pathname;
  } catch (error) {
    return m3u8Url.endsWith('/') ? m3u8Url : m3u8Url + '/';
  }
}