/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import {
  ShortDramaCategory,
  ShortDramaItem,
  ShortDramaParseResult,
} from './types';
import {
  SHORTDRAMA_CACHE_EXPIRE,
  getCacheKey,
  getCache,
  setCache,
} from './shortdrama-cache';
import { getConfig } from './config';

const SHORTDRAMA_API_BASE = 'https://api.r2afosne.dpdns.org';
const ALTERNATIVE_API_BASE = 'https://001038.xyz'; // Alternative API for when primary is down

// 获取短剧配置
async function getShortDramaConfig() {
  try {
    const config = await getConfig();
    return config.ShortDramaConfig || {
      primaryApiUrl: SHORTDRAMA_API_BASE,
      alternativeApiUrl: ALTERNATIVE_API_BASE,
      enableAlternative: false,
    };
  } catch (error) {
    console.error('获取短剧配置失败，使用默认值:', error);
    return {
      primaryApiUrl: SHORTDRAMA_API_BASE,
      alternativeApiUrl: ALTERNATIVE_API_BASE,
      enableAlternative: false,
    };
  }
}

// 检测是否为移动端环境
const isMobile = () => {
  if (typeof window === 'undefined') return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
};

// 获取API基础URL - 移动端使用内部API代理，桌面端直接调用外部API
const getApiBase = (endpoint: string) => {
  if (isMobile()) {
    return `/api/shortdrama${endpoint}`;
  }
  // 桌面端使用外部API的完整路径
  return `${SHORTDRAMA_API_BASE}/vod${endpoint}`;
};

// 获取短剧分类列表
export async function getShortDramaCategories(): Promise<ShortDramaCategory[]> {
  const cacheKey = getCacheKey('categories', {});

  try {
    // 临时禁用缓存进行测试 - 移动端强制刷新
    if (!isMobile()) {
      const cached = await getCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const apiUrl = isMobile()
      ? `/api/shortdrama/categories`
      : getApiBase('/categories');

    // 移动端使用内部API，桌面端调用外部API
    const fetchOptions: RequestInit = isMobile() ? {
      // 移动端：让浏览器使用HTTP缓存，不添加破坏缓存的headers
    } : {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    let result: ShortDramaCategory[];
    // 内部API直接返回数组，外部API返回带categories的对象
    if (isMobile()) {
      result = data; // 内部API已经处理过格式
    } else {
      const categories = data.categories || [];
      result = categories.map((item: any) => ({
        type_id: item.type_id,
        type_name: item.type_name,
      }));
    }

    // 缓存结果
    await setCache(cacheKey, result, SHORTDRAMA_CACHE_EXPIRE.categories);
    return result;
  } catch (error) {
    console.error('获取短剧分类失败:', error);
    return [];
  }
}

// 获取推荐短剧列表
export async function getRecommendedShortDramas(
  category?: number,
  size = 10
): Promise<ShortDramaItem[]> {
  const cacheKey = getCacheKey('recommends', { category, size });

  try {
    // 临时禁用缓存进行测试 - 移动端强制刷新
    if (!isMobile()) {
      const cached = await getCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const apiUrl = isMobile()
      ? `/api/shortdrama/recommend?${category ? `category=${category}&` : ''}size=${size}`
      : `${SHORTDRAMA_API_BASE}/vod/recommend?${category ? `category=${category}&` : ''}size=${size}`;

    const fetchOptions: RequestInit = isMobile() ? {
      // 移动端：让浏览器使用HTTP缓存，不添加破坏缓存的headers
    } : {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    let result: ShortDramaItem[];
    if (isMobile()) {
      result = data; // 内部API已经处理过格式
    } else {
      // 外部API的处理逻辑
      const items = data.items || [];
      result = items.map((item: any) => ({
        id: item.vod_id || item.id,
        name: item.vod_name || item.name,
        cover: item.vod_pic || item.cover,
        update_time: item.vod_time || item.update_time || new Date().toISOString(),
        score: item.vod_score || item.score || 0,
        episode_count: parseInt(item.vod_remarks?.replace(/[^\d]/g, '') || '1'),
        description: item.vod_content || item.description || '',
        author: item.vod_actor || item.author || '',
        backdrop: item.vod_pic_slide || item.backdrop || item.vod_pic || item.cover,
        vote_average: item.vod_score || item.vote_average || 0,
        tmdb_id: item.tmdb_id || undefined,
      }));
    }

    // 缓存结果
    await setCache(cacheKey, result, SHORTDRAMA_CACHE_EXPIRE.recommends);
    return result;
  } catch (error) {
    console.error('获取推荐短剧失败:', error);
    return [];
  }
}

// 获取分类短剧列表（分页）
export async function getShortDramaList(
  category: number,
  page = 1,
  size = 20
): Promise<{ list: ShortDramaItem[]; hasMore: boolean }> {
  const cacheKey = getCacheKey('lists', { category, page, size });

  try {
    // 临时禁用缓存进行测试 - 移动端强制刷新
    if (!isMobile()) {
      const cached = await getCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const apiUrl = isMobile()
      ? `/api/shortdrama/list?categoryId=${category}&page=${page}&size=${size}`
      : `${SHORTDRAMA_API_BASE}/vod/list?categoryId=${category}&page=${page}&size=${size}`;

    const fetchOptions: RequestInit = isMobile() ? {
      // 移动端：让浏览器使用HTTP缓存，不添加破坏缓存的headers
    } : {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    let result: { list: ShortDramaItem[]; hasMore: boolean };
    if (isMobile()) {
      result = data; // 内部API已经处理过格式
    } else {
      // 外部API的处理逻辑
      const items = data.list || [];
      const list = items.map((item: any) => ({
        id: item.id,
        name: item.name,
        cover: item.cover,
        update_time: item.update_time || new Date().toISOString(),
        score: item.score || 0,
        episode_count: 1, // 分页API没有集数信息，ShortDramaCard会自动获取
        description: item.description || '',
        author: item.author || '',
        backdrop: item.backdrop || item.cover,
        vote_average: item.vote_average || item.score || 0,
        tmdb_id: item.tmdb_id || undefined,
      }));

      result = {
        list,
        hasMore: data.currentPage < data.totalPages, // 使用totalPages判断是否还有更多
      };
    }

    // 缓存结果 - 第一页缓存时间更长
    const cacheTime = page === 1 ? SHORTDRAMA_CACHE_EXPIRE.lists * 2 : SHORTDRAMA_CACHE_EXPIRE.lists;
    await setCache(cacheKey, result, cacheTime);
    return result;
  } catch (error) {
    console.error('获取短剧列表失败:', error);
    return { list: [], hasMore: false };
  }
}

// 搜索短剧
export async function searchShortDramas(
  query: string,
  page = 1,
  size = 20
): Promise<{ list: ShortDramaItem[]; hasMore: boolean }> {
  try {
    const apiUrl = isMobile()
      ? `/api/shortdrama/search?query=${encodeURIComponent(query)}&page=${page}&size=${size}`
      : `${SHORTDRAMA_API_BASE}/vod/search?name=${encodeURIComponent(query)}&page=${page}&size=${size}`;

    const fetchOptions: RequestInit = isMobile() ? {
      // 移动端：让浏览器使用HTTP缓存，不添加破坏缓存的headers
    } : {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    let result: { list: ShortDramaItem[]; hasMore: boolean };
    if (isMobile()) {
      result = data; // 内部API已经处理过格式
    } else {
      // 外部API的处理逻辑
      const items = data.list || [];
      const list = items.map((item: any) => ({
        id: item.id,
        name: item.name,
        cover: item.cover,
        update_time: item.update_time || new Date().toISOString(),
        score: item.score || 0,
        episode_count: 1, // 搜索API没有集数信息，ShortDramaCard会自动获取
        description: item.description || '',
        author: item.author || '',
        backdrop: item.backdrop || item.cover,
        vote_average: item.vote_average || item.score || 0,
        tmdb_id: item.tmdb_id || undefined,
      }));

      result = {
        list,
        hasMore: data.currentPage < data.totalPages,
      };
    }

    return result;
  } catch (error) {
    console.error('搜索短剧失败:', error);
    return { list: [], hasMore: false };
  }
}

// 使用备用API解析单集视频
async function parseWithAlternativeApi(
  dramaName: string,
  episode: number
): Promise<ShortDramaParseResult> {
  try {
    // 获取配置的备用API地址
    const shortDramaConfig = await getShortDramaConfig();
    const alternativeApiBase = shortDramaConfig.alternativeApiUrl || ALTERNATIVE_API_BASE;

    // 检查是否启用备用API
    if (!shortDramaConfig.enableAlternative || !alternativeApiBase) {
      console.log('备用API未启用或未配置');
      return {
        code: -1,
        msg: '备用API未启用',
      };
    }

    // Step 1: Search for the drama by name to get drama ID
    const searchUrl = `${alternativeApiBase}/api/v1/drama/dl?dramaName=${encodeURIComponent(dramaName)}`;
    const searchResponse = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    });

    if (!searchResponse.ok) {
      throw new Error(`Search failed: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();
    if (!searchData.data || searchData.data.length === 0) {
      return {
        code: 1,
        msg: '未找到该短剧',
      };
    }

    const dramaId = searchData.data[0].id;

    // Step 2: Get all episodes for this drama
    const episodesUrl = `${alternativeApiBase}/api/v1/drama/dramas?dramaId=${dramaId}`;
    const episodesResponse = await fetch(episodesUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    });

    if (!episodesResponse.ok) {
      throw new Error(`Episodes fetch failed: ${episodesResponse.status}`);
    }

    const episodesData = await episodesResponse.json();
    if (!episodesData.data || episodesData.data.length < episode) {
      return {
        code: 1,
        msg: `集数 ${episode} 不存在`,
      };
    }

    const episodeId = episodesData.data[episode - 1].id;

    // Step 3: Get the direct link for the episode
    const directUrl = `${alternativeApiBase}/api/v1/drama/direct?episodeId=${episodeId}`;
    const directResponse = await fetch(directUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    });

    if (!directResponse.ok) {
      throw new Error(`Direct link fetch failed: ${directResponse.status}`);
    }

    const directData = await directResponse.json();

    return {
      code: 0,
      data: {
        videoId: dramaId,
        videoName: searchData.data[0].name,
        currentEpisode: episode,
        totalEpisodes: episodesData.data.length,
        parsedUrl: directData.url || '',
        proxyUrl: directData.url || '',
        cover: directData.pic || searchData.data[0].pic || '',
        description: searchData.data[0].overview || '',
        episode: {
          index: episode,
          label: `第${episode}集`,
          parsedUrl: directData.url || '',
          proxyUrl: directData.url || '',
          title: directData.title || `第${episode}集`,
        },
      },
      // 额外的元数据供其他地方使用
      metadata: {
        author: searchData.data[0].author || '',
        backdrop: searchData.data[0].backdrop || searchData.data[0].pic || '',
        vote_average: searchData.data[0].vote_average || 0,
        tmdb_id: searchData.data[0].tmdb_id || undefined,
      }
    };
  } catch (error) {
    console.error('备用API解析失败:', error);
    return {
      code: -1,
      msg: '备用API请求失败',
    };
  }
}

// 解析单集视频（支持跨域代理，自动fallback到备用API）
export async function parseShortDramaEpisode(
  id: number,
  episode: number,
  useProxy = true,
  dramaName?: string
): Promise<ShortDramaParseResult> {
  try {
    const params = new URLSearchParams({
      id: id.toString(), // API需要string类型的id
      episode: episode.toString(), // episode从1开始
    });

    if (useProxy) {
      params.append('proxy', 'true');
    }

    const timestamp = Date.now();
    const apiUrl = isMobile()
      ? `/api/shortdrama/parse?${params.toString()}&_t=${timestamp}`
      : `${SHORTDRAMA_API_BASE}/vod/parse/single?${params.toString()}`;

    const fetchOptions: RequestInit = isMobile() ? {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    } : {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // API可能返回错误信息
    if (data.code === 1) {
      // 如果主API失败且提供了剧名，尝试使用备用API
      if (dramaName) {
        console.log('主API失败，尝试使用备用API...');
        return await parseWithAlternativeApi(dramaName, episode);
      }
      return {
        code: data.code,
        msg: data.msg || '解析失败',
      };
    }

    // API成功时直接返回数据对象，根据实际结构解析
    return {
      code: 0,
      data: {
        videoId: data.videoId || id,
        videoName: data.videoName || '',
        currentEpisode: data.episode?.index || episode,
        totalEpisodes: data.totalEpisodes || 1,
        parsedUrl: data.episode?.parsedUrl || data.parsedUrl || '',
        proxyUrl: data.episode?.proxyUrl || '', // proxyUrl在episode对象内
        cover: data.cover || '',
        description: data.description || '',
        episode: data.episode || null, // 保留原始episode对象
      },
    };
  } catch (error) {
    console.error('解析短剧集数失败:', error);
    // 如果主API网络请求失败且提供了剧名，尝试使用备用API
    if (dramaName) {
      console.log('主API网络错误，尝试使用备用API...');
      return await parseWithAlternativeApi(dramaName, episode);
    }
    return {
      code: -1,
      msg: '网络请求失败',
    };
  }
}

// 批量解析多集视频
export async function parseShortDramaBatch(
  id: number,
  episodes: number[],
  useProxy = true
): Promise<ShortDramaParseResult[]> {
  try {
    const params = new URLSearchParams({
      id: id.toString(),
      episodes: episodes.join(','),
    });

    if (useProxy) {
      params.append('proxy', 'true');
    }

    const timestamp = Date.now();
    const apiUrl = isMobile()
      ? `/api/shortdrama/parse?${params.toString()}&_t=${timestamp}`
      : `${SHORTDRAMA_API_BASE}/vod/parse/batch?${params.toString()}`;

    const fetchOptions: RequestInit = isMobile() ? {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    } : {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('批量解析短剧失败:', error);
    return [];
  }
}

// 解析整部短剧所有集数
export async function parseShortDramaAll(
  id: number,
  useProxy = true
): Promise<ShortDramaParseResult[]> {
  try {
    const params = new URLSearchParams({
      id: id.toString(),
    });

    if (useProxy) {
      params.append('proxy', 'true');
    }

    const timestamp = Date.now();
    const apiUrl = isMobile()
      ? `/api/shortdrama/parse?${params.toString()}&_t=${timestamp}`
      : `${SHORTDRAMA_API_BASE}/vod/parse/all?${params.toString()}`;

    const fetchOptions: RequestInit = isMobile() ? {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    } : {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      mode: 'cors',
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('解析完整短剧失败:', error);
    return [];
  }
}