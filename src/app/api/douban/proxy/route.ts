/* eslint-disable no-console */
import * as cheerio from 'cheerio';
import { unstable_cache } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// URL 常量
const DOUBAN_WEB_BASE = 'https://movie.douban.com';

// Chrome/Mac 真实 User-Agent
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://movie.douban.com/',
  'Sec-Ch-Ua':
    '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Cache-Control': 'no-cache',
};

// ============================================================================
// 数据类型定义
// ============================================================================

interface ScrapedComment {
  id: string;
  created_at: string;
  content: string;
  useful_count: number;
  rating: { max: number; value: number; min: number } | null;
  author: {
    id: string;
    uid: string;
    name: string;
    avatar: string;
    alt: string;
  };
}

interface ScrapedRecommendation {
  id: string;
  title: string;
  images: { small: string; medium: string; large: string };
  alt: string;
}

interface ScrapedCelebrity {
  id: string;
  name: string;
  alt: string;
  category: string;
  role: string;
  avatars: { small: string; medium: string; large: string };
}

interface ScrapedFullData {
  // 基础信息
  title: string;
  original_title: string;
  year: string;
  rating: { average: number; stars: string; count: number } | null;
  genres: string[];
  countries: string[];
  durations: string[];
  summary: string;
  poster: string;
  // 富媒体数据
  recommendations: ScrapedRecommendation[];
  hotComments: ScrapedComment[];
  directors: ScrapedCelebrity[];
  actors: ScrapedCelebrity[];
  // 元数据
  scrapedAt: number;
}

// ============================================================================
// 核心爬虫函数
// ============================================================================

/**
 * 从豆瓣网页一次性抓取所有数据
 * 包括：基础信息、推荐影片、热门短评、导演/演员
 */
async function _scrapeDoubanData(subjectId: string): Promise<ScrapedFullData> {
  console.log(`[Douban Scraper] 开始爬取: ${subjectId}`);
  const startTime = Date.now();

  const url = `${DOUBAN_WEB_BASE}/subject/${subjectId}/`;

  const response = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`爬取失败: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // ========== 基础信息 ==========
  const title =
    $('span[property="v:itemreviewed"]').text().trim() ||
    $('title').text().split(' ')[0];
  const originalTitle =
    $('span.pl:contains("又名")').next().text().trim() || '';
  const year = $('span.year').text().replace(/[()]/g, '').trim() || '';

  // 评分
  const ratingAvg = parseFloat($('strong.rating_num').text().trim()) || 0;
  const ratingStars = $('span.rating_per').first().text().trim() || '';
  const ratingCount =
    parseInt($('span[property="v:votes"]').text().trim()) || 0;

  // 类型、地区、时长
  const genres: string[] = [];
  $('span[property="v:genre"]').each((_, el) => {
    genres.push($(el).text().trim());
  });

  const countries: string[] = [];
  const countryText = $('span.pl:contains("制片国家")').parent().text();
  const countryMatch = countryText.match(/制片国家\/地区:\s*(.+)/);
  if (countryMatch) {
    countries.push(...countryMatch[1].split('/').map((s) => s.trim()));
  }

  const durations: string[] = [];
  $('span[property="v:runtime"]').each((_, el) => {
    durations.push($(el).text().trim());
  });

  // 简介 (完整版)
  let summary = '';
  const $hiddenSummary = $('span.all.hidden');
  if ($hiddenSummary.length) {
    summary = $hiddenSummary.text().trim();
  } else {
    summary = $('span[property="v:summary"]').text().trim();
  }
  summary = summary.replace(/\s+/g, ' ').trim();

  // 海报
  const poster = $('#mainpic img').attr('src') || '';

  // ========== 推荐影片 ==========
  const recommendations: ScrapedRecommendation[] = [];
  $('#recommendations .recommendations-bd dl').each((_, element) => {
    const $item = $(element);
    const $link = $item.find('dd a');
    const $img = $item.find('dt img');

    const href = $link.attr('href') || '';
    const idMatch = href.match(/subject\/(\d+)/);
    const recId = idMatch ? idMatch[1] : '';
    const recTitle = $link.text().trim();
    const recPoster = $img.attr('src') || '';

    if (recId && recTitle) {
      recommendations.push({
        id: recId,
        title: recTitle,
        images: {
          small: recPoster,
          medium: recPoster.replace('s_ratio', 'm_ratio'),
          large: recPoster.replace('s_ratio', 'l_ratio'),
        },
        alt: href,
      });
    }
  });

  // ========== 热门短评 ==========
  const hotComments: ScrapedComment[] = [];
  $('#hot-comments .comment-item').each((_, element) => {
    const $item = $(element);

    const $avatar = $item.find('.avatar a img');
    const $userLink = $item.find('.comment-info a');
    const avatarUrl = $avatar.attr('src') || '';
    const userName = $userLink.text().trim();
    const userLink = $userLink.attr('href') || '';

    const ratingClass = $item.find('.comment-info .rating').attr('class') || '';
    const ratingMatch = ratingClass.match(/allstar(\d+)/);
    const ratingValue = ratingMatch ? parseInt(ratingMatch[1]) / 10 : 0;

    const content = $item.find('.short').text().trim();
    const time =
      $item.find('.comment-time').attr('title') ||
      $item.find('.comment-time').text().trim();
    const usefulCount = parseInt($item.find('.vote-count').text().trim()) || 0;
    const commentId =
      $item.attr('data-cid') || `hot_${Date.now()}_${Math.random()}`;

    if (content) {
      hotComments.push({
        id: commentId,
        created_at: time,
        content,
        useful_count: usefulCount,
        rating: ratingValue > 0 ? { max: 5, value: ratingValue, min: 0 } : null,
        author: {
          id: userLink.split('/').filter(Boolean).pop() || '',
          uid: userName,
          name: userName,
          avatar: avatarUrl
            .replace('/u/pido/', '/u/')
            .replace('s_ratio', 'm_ratio'),
          alt: userLink,
        },
      });
    }
  });

  // ========== 导演/演员 (从主页解析) ==========
  const directors: ScrapedCelebrity[] = [];
  const actors: ScrapedCelebrity[] = [];

  // 导演
  $('a[rel="v:directedBy"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const idMatch = href.match(/celebrity\/(\d+)/);
    const name = $el.text().trim();

    if (name) {
      directors.push({
        id: idMatch ? idMatch[1] : '',
        name,
        alt: href,
        category: '导演',
        role: '导演',
        avatars: { small: '', medium: '', large: '' },
      });
    }
  });

  // 演员
  $('a[rel="v:starring"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const idMatch = href.match(/celebrity\/(\d+)/);
    const name = $el.text().trim();

    if (name) {
      actors.push({
        id: idMatch ? idMatch[1] : '',
        name,
        alt: href,
        category: '演员',
        role: '',
        avatars: { small: '', medium: '', large: '' },
      });
    }
  });

  // 尝试从 celebrities 区块获取头像
  $('#celebrities .celebrity').each((_, element) => {
    const $item = $(element);
    const $link = $item.find('a.name');
    const $avatar = $item.find('.avatar');

    const href = $link.attr('href') || '';
    const idMatch = href.match(/celebrity\/(\d+)/);
    const celId = idMatch ? idMatch[1] : '';
    const name = $link.text().trim();
    const role = $item.find('.role').text().trim();

    // 双重匹配头像 URL
    let avatarUrl = '';

    // 方法 1: CSS 背景图
    const avatarStyle = $avatar.attr('style') || '';
    const bgMatch = avatarStyle.match(/background-image:\s*url\(([^)]+)\)/);
    if (bgMatch) {
      avatarUrl = bgMatch[1].replace(/['"]|&quot;/g, '');
    }

    // 方法 2: IMG 标签 (fallback)
    if (!avatarUrl) {
      const $img = $avatar.find('img');
      avatarUrl = $img.attr('src') || $img.attr('data-src') || '';
    }

    // 方法 3: 直接从 a 标签下的 img
    if (!avatarUrl) {
      const $directImg = $item.find('a img.avatar, a img[class*="avatar"]');
      avatarUrl = $directImg.attr('src') || '';
    }

    // 高清图替换: /s/ -> /l/, /m/ -> /l/
    avatarUrl = avatarUrl
      .replace(/\/s\//, '/l/')
      .replace(/\/m\//, '/l/')
      .replace('/s_ratio/', '/l_ratio/')
      .replace('/m_ratio/', '/l_ratio/')
      .replace('/small/', '/large/')
      .replace('/medium/', '/large/');

    if (name) {
      const isDirector = role.includes('导演');
      const target = isDirector ? directors : actors;

      // 更新或添加
      const existing = target.find((c) => c.id === celId || c.name === name);
      if (existing) {
        // 只有当新头像有效时才更新
        if (avatarUrl) {
          existing.avatars = {
            small: avatarUrl
              .replace('/l/', '/s/')
              .replace('/l_ratio/', '/s_ratio/'),
            medium: avatarUrl
              .replace('/l/', '/m/')
              .replace('/l_ratio/', '/m_ratio/'),
            large: avatarUrl,
          };
        }
        if (role) existing.role = role;
      } else {
        target.push({
          id: celId || `cel_${Date.now()}_${Math.random()}`,
          name,
          alt: href,
          category: isDirector ? '导演' : '演员',
          role,
          avatars: {
            small: avatarUrl
              ? avatarUrl
                  .replace('/l/', '/s/')
                  .replace('/l_ratio/', '/s_ratio/')
              : '',
            medium: avatarUrl
              ? avatarUrl
                  .replace('/l/', '/m/')
                  .replace('/l_ratio/', '/m_ratio/')
              : '',
            large: avatarUrl || '',
          },
        });
      }
    }
  });

  const elapsed = Date.now() - startTime;
  console.log(`[Douban Scraper] 完成: ${subjectId} (${elapsed}ms)`);

  return {
    title,
    original_title: originalTitle,
    year,
    rating:
      ratingAvg > 0
        ? { average: ratingAvg, stars: ratingStars, count: ratingCount }
        : null,
    genres,
    countries,
    durations,
    summary,
    poster,
    recommendations,
    hotComments,
    directors,
    actors,
    scrapedAt: Date.now(),
  };
}

// ============================================================================
// 服务端缓存封装 (24小时)
// ============================================================================

/**
 * 使用 Next.js unstable_cache 包裹爬虫函数
 * - 第一次访问会触发爬虫
 * - 后续请求直接读取缓存
 * - 24小时后自动重新验证
 */
const scrapeDoubanData = unstable_cache(_scrapeDoubanData, ['douban-scraper'], {
  revalidate: 86400, // 24小时缓存
  tags: ['douban'],
});

// 独立的评论爬取（带缓存）
const scrapeComments = unstable_cache(
  async (
    subjectId: string,
    start = 0,
    count = 10,
  ): Promise<{ comments: ScrapedComment[]; total: number }> => {
    const url = `${DOUBAN_WEB_BASE}/subject/${subjectId}/comments?start=${start}&limit=${count}&status=P&sort=new_score`;

    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`爬取短评失败: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const comments: ScrapedComment[] = [];

    $('.comment-item').each((_, element) => {
      const $item = $(element);

      const $avatar = $item.find('.avatar a img');
      const $userLink = $item.find('.comment-info a');
      const avatarUrl = $avatar.attr('src') || '';
      const userName = $userLink.text().trim();
      const userLink = $userLink.attr('href') || '';

      const ratingClass =
        $item.find('.comment-info .rating').attr('class') || '';
      const ratingMatch = ratingClass.match(/allstar(\d+)/);
      const ratingValue = ratingMatch ? parseInt(ratingMatch[1]) / 10 : 0;

      const content = $item.find('.short').text().trim();
      const time =
        $item.find('.comment-time').attr('title') ||
        $item.find('.comment-time').text().trim();
      const usefulCount =
        parseInt($item.find('.vote-count').text().trim()) || 0;
      const commentId =
        $item.attr('data-cid') || `scrape_${Date.now()}_${Math.random()}`;

      if (content) {
        comments.push({
          id: commentId,
          created_at: time,
          content,
          useful_count: usefulCount,
          rating:
            ratingValue > 0 ? { max: 5, value: ratingValue, min: 0 } : null,
          author: {
            id: userLink.split('/').filter(Boolean).pop() || '',
            uid: userName,
            name: userName,
            avatar: avatarUrl
              .replace('/u/pido/', '/u/')
              .replace('s_ratio', 'm_ratio'),
            alt: userLink,
          },
        });
      }
    });

    const totalText = $('.mod-hd h2 span').text();
    const totalMatch = totalText.match(/全部\s*(\d+)\s*条/);
    const total = totalMatch ? parseInt(totalMatch[1]) : comments.length;

    return { comments, total };
  },
  ['douban-comments'],
  { revalidate: 3600, tags: ['douban'] },
);

// ============================================================================
// 路由处理
// ============================================================================

function needsScraping(
  path: string,
): 'full' | 'comments' | null {
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes('/comments') || lowerPath.includes('/reviews')) {
    return 'comments';
  }
  // 如果只是 subject/{id}，返回完整数据
  if (/movie\/subject\/\d+\/?$/.test(path)) {
    return 'full';
  }
  return null;
}

function extractSubjectId(path: string): string | null {
  const match = path.match(/subject\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * GET /api/douban/proxy
 * 豆瓣数据代理 (智能爬虫 + 24小时缓存)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const path = searchParams.get('path');
    const start = parseInt(searchParams.get('start') || '0');
    const count = parseInt(searchParams.get('count') || '10');

    if (!path) {
      return NextResponse.json(
        { error: '缺少必要参数: path', code: 400 },
        { status: 400 },
      );
    }

    const scrapeType = needsScraping(path);
    const subjectId = extractSubjectId(path);

    // ========== 爬虫模式 ==========
    if (scrapeType && subjectId) {
      console.log(`[Douban Proxy] 爬虫模式: ${scrapeType} for ${subjectId}`);

      let data: unknown;

      switch (scrapeType) {
        case 'full':
          data = await scrapeDoubanData(subjectId);
          break;
        case 'comments':
          data = await scrapeComments(subjectId, start, count);
          break;
      }

      return NextResponse.json(data, {
        headers: {
          'Cache-Control':
            'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200',
          'X-Data-Source': 'scraper-cached',
        },
      });
    }

    // 如果不是支持的路径，返回错误
    return NextResponse.json(
      {
        error: '不支持的路径',
        message: '当前仅支持: movie/subject/{id} 和 movie/subject/{id}/comments',
      },
      { status: 400 },
    );
  } catch (error) {
    console.error('[Douban Proxy] Error:', error);

    if (error instanceof Error && error.name === 'TimeoutError') {
      return NextResponse.json(
        { error: '请求超时', code: 504 },
        { status: 504 },
      );
    }

    return NextResponse.json(
      {
        error: '代理请求失败',
        details: error instanceof Error ? error.message : '未知错误',
      },
      { status: 500 },
    );
  }
}
