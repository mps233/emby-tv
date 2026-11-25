/**
 * Emby -> tv app 原生频道（uts v3 响应改写）
 * 拦截 uts-api.itunes.apple.com/uts/v3/* 的响应，把 Emby 媒体库伪造成一个原生频道。
 * 环境：Surge / Loon / Stash / Quantumult X（http-response 脚本）
 *
 * ⚠️ 骨架版本：schema 取自 Apple TV app v74 真实响应（2026-11 实测），
 *    标了 VERIFY 的字段必须在真机上跑一遍确认。
 */

/* ============================ 配置 ============================ */
var CONFIG = {
  embyBase: "https://YOUR_EMBY_HOST",         // Emby 地址，不要带结尾斜杠；建议 https
  embyApiKey: "YOUR_EMBY_API_KEY",
  embyUserId: "YOUR_EMBY_USER_ID",
  imageStyle: "raw-id",                      // "standard" = 标准 Emby 图片路由；"raw-id" = 自定义网关 /img/i/*
  libraryId: "",                             // 留空 = 全库；填某个媒体库 Id 可只注入该库

  brandId: "emby.local.library",             // 频道唯一标识，建议用域名反写
  brandName: "Emby",
  brandColor: "#14161A",
  tabTitle: "Emby",                          // 侧边栏文字
  tabType: "Originals",                      // VERIFY: 必须是客户端认识的枚举

  recentLimit: 24,
  resumeLimit: 12,

  hlsMaxBitrate: "20000000",
  remuxBase: "http://192.168.50.44:8900",   // 本机 remux 中转服务
};

// 支持通过模块 argument 覆盖敏感项，避免把 API Key 写进公开脚本：
//   argument="embyBase=https://xxx&embyApiKey=yyy&embyUserId=zzz"
(function applyArguments() {
  if (typeof $argument === "undefined" || !$argument) return;
  var pairs = String($argument).split(/[&,]/);
  for (var i = 0; i < pairs.length; i++) {
    var kv = pairs[i].split("=");
    if (kv.length < 2) continue;
    var k = kv[0].trim();
    var v = decodeURIComponent(kv.slice(1).join("=").trim());
    if (k === "embyBase") CONFIG.embyBase = v;
    else if (k === "embyApiKey") CONFIG.embyApiKey = v;
    else if (k === "embyUserId") CONFIG.embyUserId = v;
    else if (k === "brandName") CONFIG.brandName = v;
    else if (k === "tabTitle") CONFIG.tabTitle = v;
    else if (k === "brandId") CONFIG.brandId = v;
  }
})();

/* ============================ 常量 ============================ */

// Tab / Brand 图标：100x100 白色 SVG，base64 内嵌（客户端不联网取图）
var ICON_B64 =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAwIiB2aWV3Qm94PSIwIDAgMTAwIDEwMCI+PHJlY3QgeD0iNyIgeT0iMTUiIHdpZHRoPSI4NiIgaGVpZ2h0PSI3MCIgcng9IjEyIiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iOCIvPjxwYXRoIGQ9Ik00MSAzMyBMNzEgNTAgTDQxIDY3IFoiIGZpbGw9IiNGRkZGRkYiLz48L3N2Zz4=";

// 调试回传：把请求路径打到 Mac 上的 8899 服务，用来确认 TV app 真实发了什么
function beacon(tag) {
  try {
    if (typeof $httpClient === "undefined") return;
    $httpClient.get({ url: "http://192.168.50.44:8899/beacon?d=" + encodeURIComponent(tag) }, function () {});
  } catch (e) {}
}

var ID_PREFIX = "emby-";
var FAV = "f0133578"; // playable id 的第三段，固定值即可

/* ============================ 工具 ============================ */

function log(s) { console.log("[emby-tv] " + s); }

function parseUrl(u) {
  var m = /^(https?):\/\/([^\/?#]+)([^?#]*)(?:\?([^#]*))?/i.exec(u || "") || [];
  return { host: m[2] || "", path: m[3] || "/", query: m[4] || "" };
}

function qs(query, key) {
  var parts = (query || "").split("&");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].split("=");
    if (p[0] === key) return decodeURIComponent(p[1] || "");
  }
  return "";
}

// URL 里的 slug 必须是纯 ASCII，中文标题一律退化，否则客户端请求路径会带未编码字符
function slug(s) {
  var out = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "item";
}

function get(url, headers) {
  return new Promise(function (resolve, reject) {
    if (typeof $httpClient !== "undefined") {
      $httpClient.get({ url: url, headers: headers || {} }, function (err, resp, data) {
        if (err) return reject(new Error(String(err)));
        resolve(data);
      });
    } else if (typeof $task !== "undefined") {
      $task.fetch({ url: url, headers: headers || {} }).then(function (r) { resolve(r.body); }, reject);
    } else {
      reject(new Error("no http client"));
    }
  });
}

function base() { return CONFIG.embyBase.replace(/\/+$/, ""); }

function embyGet(path) {
  var sep = path.indexOf("?") === -1 ? "?" : "&";
  return get(base() + path + sep + "api_key=" + encodeURIComponent(CONFIG.embyApiKey)).then(function (t) {
    return JSON.parse(t);
  });
}

var FIELDS = "Genres,PremiereDate,ProductionYear,CommunityRating,OfficialRating,Overview,ImageTags,BackdropImageTags,MediaSources,RunTimeTicks";

function userPath(p) { return "/emby/Users/" + CONFIG.embyUserId + p; }

/* ============================ uts 数据构造 ============================ */

function svgIcon(weight) {
  return { embeddedData: ICON_B64, format: "embeddedSvg", weight: weight };
}

// Tab 的四个图标槽位缺一不可，客户端按 bold/regular/medium 分别取用
function tabIcons() {
  return {
    boldImage: svgIcon("bold"),
    defaultImage: svgIcon("regular"),
    mediumImage: svgIcon("medium"),
    regularImage: svgIcon("regular"),
  };
}

function img(url, w, h) {
  return { url: url, width: w, height: h, supportsLayeredImage: false, isP3: false };
}

function embyImage(itemId, kind) {
  // 真实格式是 /image/thumb/<单段token>/{w}x{h}.{f}，路径段数不能多，
  // 所以把 id 和变体塞进同一个 token 里：emby-<id>-<p|b|l>
  var raw = String(itemId).replace(/^[a-z]/, "");
  var v = kind === "logo" ? "l" : kind === "primary" ? "p" : "b";
  return "https://is1-ssl.mzstatic.com/image/thumb/emby-" + raw + "-" + v + "/{w}x{h}.{f}";
}

function buildTab() {
  return {
    destinationType: "Target",
    hexColor: CONFIG.brandColor,
    images: tabIcons(),
    target: { id: CONFIG.brandId, type: "Brand", url: "https://tv.apple.com/us/channel/emby/" + CONFIG.brandId },
    title: CONFIG.tabTitle,
    type: CONFIG.tabType,
    universalLinks: ["https://tv.apple.com/channel/" + CONFIG.brandId],
  };
}

function buildBrand() {
  return {
    appAdamIds: [],
    appAgeRestrictionRatingValue: 100,
    appBundleIds: [],
    appName: CONFIG.brandName,
    appStoreUrl: "",
    hexColor: CONFIG.brandColor,
    id: CONFIG.brandId,
    images: {
      appIcon: img(embyImage("brand", "primary"), 1280, 768), // VERIFY: 也可换成 embeddedSvg
      logoGlyph: svgIcon("regular"),
      whiteLogo: svgIcon("regular"),
    },
    isApSubscription: false,
    isAppleMusicImmersiveBrand: false,
    isAppleTvPlus: false,
    isConsented: true,
    isFirstParty: false,
    isInstalled: false,
    isItunes: false,
    isMountainBrand: false,
    isStaging: false,
    isSubscribed: true,        // 关键：设 true 才不会弹订阅/购买
    isTvAppBrand: false,
    isWatchlistEnabled: true,
    name: CONFIG.brandName,
    shouldTrackPlayActivity: true,
    title: CONFIG.brandName,
    type: "Brand",
    url: "https://tv.apple.com/us/channel/emby/" + CONFIG.brandId,
  };
}

function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }

function buildItem(e) {
  // 单集折叠成所属剧集：TV app 的「继续观看」里展示的是剧集卡片，
  // 直接把 episode id 塞进 Show 类型会被客户端静默丢弃，表现就是"只有电影没有剧集"。
  var src = e;
  if (e.Type === "Episode" && e.SeriesId) {
    src = {
      Id: e.SeriesId,
      Name: e.SeriesName || e.Name,
      Type: "Series",
      Genres: e.Genres,
      Overview: e.Overview,
      PremiereDate: e.PremiereDate,
      ProductionYear: e.ProductionYear,
      CommunityRating: e.CommunityRating,
    };
  }
  var isMovie = src.Type === "Movie";
  var id = ID_PREFIX + src.Id;
  var kind = isMovie ? "movie" : "show";
  var genres = (src.Genres || []).slice(0, 3).map(function (g) {
    return { id: "emby.genre." + slug(g), name: g, type: "Genre", url: "https://tv.apple.com/us/genre/" + slug(g) + "/emby.genre." + slug(g) };
  });
  var item = {
    id: id,
    type: isMovie ? "Movie" : "Show",
    localizedType: isMovie ? "Movie" : "TV Show",
    title: src.Name,
    url: "https://tv.apple.com/us/" + kind + "/" + slug(src.Name) + "/" + id + "?ctx_brand=" + CONFIG.brandId,
    images: {
      contentImage: img(embyImage(src.Id, "backdrop"), 3840, 2160),
      contentImageTall: img(embyImage(src.Id, "primary"), 1000, 1500),
      contentLogo: img(embyImage(src.Id, "logo"), 800, 310),
      posterArt: img(embyImage(src.Id, "primary"), 1000, 1500),
      showPosterArt: img(embyImage(src.Id, "primary"), 1000, 1500),
      shelfImage: img(embyImage(src.Id, "backdrop"), 1920, 1080),
      shelfImageBackground: img(embyImage(src.Id, "backdrop"), 1920, 1080),
    },
    genres: genres,
    playbackModes: ["Monoscopic"],
    playables: [playableObject(src)],
    heroDescription: src.Overview || "",
    isWatched: false,
    releaseDate: src.PremiereDate ? Date.parse(src.PremiereDate) : undefined,
  };
  if (typeof src.CommunityRating === "number") {
    item.rating = { system: "emby", systemType: "apps", name: "EMBY", displayName: src.CommunityRating.toFixed(1), value: Math.round(src.CommunityRating * 10) };
  }
  if (e.Type === "Episode") {
    item.smartEpisode = {
      episodeNumber: e.IndexNumber || 1,
      seasonNumber: e.ParentIndexNumber || 1,
      title: e.Name,
      duration: num(Math.round((e.RunTimeTicks || 0) / 10000000), 0),
      images: { contentImage: img(embyImage(e.Id, "backdrop"), 3840, 2160) },
    };
  }
  return item;
}

function buildShelf(id, title, displayType, items) {
  return {
    id: id,
    title: title,
    displayType: displayType,
    channelId: CONFIG.brandId,
    items: items,
    url: "https://tv.apple.com/us/collection/" + slug(title) + "/" + id + "?ctx_brand=" + CONFIG.brandId,
  };
}

function buildCanvas(shelves) {
  return {
    id: "uts.tcvs." + CONFIG.brandId + "-canvas",
    canvasInfo: { canvasType: "Channel", entityId: CONFIG.brandId },
    cachingPolicy: { cache: false, type: "RefreshWithInterval", maxAge: 0 },
    shelves: shelves,
    url: "https://tv.apple.com/us/channel/emby/" + CONFIG.brandId,
  };
}

function hlsUrl(embyId) {
  // 源站只给 MKV 原始文件、且禁用转码，AVPlayer 无法直接播。
  // 交给本机 remux 服务：视频流 copy、音轨转 AAC，封装成 fMP4 的 HLS。
  return CONFIG.remuxBase + "/hls/" + embyId + "/index.m3u8";
}

function playableObject(e) {
  var seconds = num(Math.round((e.RunTimeTicks || 0) / 10000000), 0);
  return {
    id: CONFIG.brandId + ":" + e.Id + ":" + FAV,
    airingType: "OnDemand",
    type: "Vod",
    contentType: e.Type === "Movie" ? "Movie" : "Episode",
    canonicalId: ID_PREFIX + e.Id,
    channelId: CONFIG.brandId,
    contentId: ID_PREFIX + e.Id,
    externalId: e.Id,
    title: e.Name,
    duration: seconds,
    isEntitledToPlay: true,
    isEntitledToPlayOnDevice: true,
    isGeoRestricted: false,
    isConsented: true,
    isDownloadable: false,
    isEligibleForPlayerTabs: false,
    entitlementReason: "Free",
    playbackModes: ["Monoscopic"],
    assets: { hlsUrl: hlsUrl(e.Id), duration: seconds },
    canonicalMetadata: {
      movieTitle: e.Name,
      duration: seconds,
      genre: (e.Genres || [])[0] || "",
      images: { contentImage: img(embyImage(e.Id, "backdrop"), 3840, 2160) },
    },
  };
}

function buildPlayable(e) {
  var p = {};
  var obj = playableObject(e);
  p[obj.id] = obj;
  return p;
}

/* ============================ 数据拉取 ============================ */

function fetchRecent() {
  var p = userPath("/Items/Latest?Limit=" + CONFIG.recentLimit + "&Fields=" + FIELDS);
  if (CONFIG.libraryId) p += "&ParentId=" + CONFIG.libraryId;
  return embyGet(p);
}

function fetchResume() {
  return embyGet(userPath("/Items/Resume?Limit=" + CONFIG.resumeLimit + "&MediaTypes=Video&Fields=" + FIELDS));
}

function fetchByType(type) {
  var p = userPath("/Items?Recursive=true&IncludeItemTypes=" + type + "&SortBy=DateCreated&SortOrder=Descending&Limit=24&Fields=" + FIELDS);
  if (CONFIG.libraryId) p += "&ParentId=" + CONFIG.libraryId;
  return embyGet(p);
}

function onlyAV(items) {
  return (items || []).filter(function (e) { return e && (e.Type === "Movie" || e.Type === "Series" || e.Type === "Episode"); });
}

/* ============================ 处理器 ============================ */

function handleConfigurations(body) {
  var props = body && body.data && body.data.applicationProps;
  if (!props) return body;
  var tabs = props.tabs || [];
  var exists = tabs.some(function (t) { return t && t.target && t.target.id === CONFIG.brandId; });
  if (!exists) {
    tabs.splice(tabs.length - 1, 0, buildTab()); // 插在 Library 之前
    props.tabs = tabs;
    log("tab injected");
  }
  return body;
}

function handleChannels(body) {
  var data = body && body.data;
  if (!data) return body;
  if (Array.isArray(data.channels)) {
    // VERIFY: 某些版本返回的是数组而不是字典，两种都兜住
    if (!data.channels.some(function (c) { return c && c.id === CONFIG.brandId; })) data.channels.push(buildBrand());
  } else {
    data.channels = data.channels || {};
    data.channels[CONFIG.brandId] = buildBrand();
  }
  log("brand injected");
  return body;
}

function buildEpisode(e, showName, showId) {
  var id = ID_PREFIX + e.Id;
  var season = e.ParentIndexNumber || 1;
  var no = e.IndexNumber || 0;
  return {
    id: id,
    type: "Episode",
    title: e.Name,
    description: e.Overview || "",
    duration: num(Math.round((e.RunTimeTicks || 0) / 10000000), 0),
    episodeNumber: no,
    seasonNumber: season,
    episodeIndex: no > 0 ? no - 1 : 0,
    fractionalEpisodeNumber: no,
    isFirstEpisode: no === 1,
    playbackModes: ["Monoscopic"],
    showId: showId,
    showTitle: showName || "",
    showUrl: "https://tv.apple.com/us/show/" + slug(showName) + "/" + showId,
    seasonId: "emby.season." + showId + "." + season,
    seasonUrl: "https://tv.apple.com/us/season/s" + season + "/emby.season." + showId + "." + season + "?showId=" + showId,
    url: "https://tv.apple.com/us/episode/" + slug(e.Name) + "/" + id + "?showId=" + showId,
    images: {
      contentImage: img(embyImage(e.Id, "backdrop"), 3840, 2160),
      posterArt: img(embyImage(e.Id, "primary"), 1000, 1500),
      showPosterArt: img(embyImage(showId.replace(ID_PREFIX, ""), "primary"), 1000, 1500),
    },
  };
}

function handleEpisodes(body, seriesId) {
  var embyId = seriesId.replace(ID_PREFIX, "");
  return embyGet("/emby/Shows/" + embyId + "/Episodes?UserId=" + CONFIG.embyUserId + "&Fields=" + FIELDS).then(function (r) {
    var items = (r.Items || []).slice(0, 500);
    var showName = items.length ? items[0].SeriesName : "";
    var episodes = items.map(function (e) { return buildEpisode(e, showName, seriesId); });
    var playables = {};
    for (var i = 0; i < items.length; i++) {
      var p = buildPlayable(items[i]);
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) playables[k] = p[k];
    }
    var ch = {};
    ch[CONFIG.brandId] = buildBrand();
    log("episodes built: " + episodes.length);
    return {
      data: {
        channels: ch,
        episodes: episodes,
        episodesPlayables: playables,
        episodesContentPersonalizedInfo: {},
        playables: playables,
        selectedEpisodeIndex: 0,
        totalEpisodeCount: episodes.length,
      },
      utsk: body.utsk,
    };
  });
}

// 侧边栏 Tab 来自 configurations，但 tvOS 把它缓存在磁盘里、几个小时不刷新。
// 主页画布每次启动都重新请求，所以在这里也插一份 Emby 内容，保证入口一定能看到。
function handleWatchNow(body) {
  return Promise.all([fetchResume(), fetchRecent()]).then(function (r) {
    var resume = onlyAV(r[0].Items).slice(0, 12);
    var recent = onlyAV(r[1]).slice(0, 20);
    var canvas = body && body.data && body.data.canvas;
    if (!canvas) return body;
    var shelves = canvas.shelves || [];
    var inject = [];
    if (resume.length) inject.push(buildShelf("emby.col.resume.home", "Emby · 继续观看", "lockup", resume.map(buildItem)));
    if (recent.length) inject.push(buildShelf("emby.col.recent.home", "Emby · 最近添加", "brick", recent.map(buildItem)));
    if (!inject.length) return body;
    var at = shelves.length > 1 ? 1 : shelves.length; // 插在头条之后，不抢 C 位
    canvas.shelves = shelves.slice(0, at).concat(inject, shelves.slice(at));
    log("watchnow injected: " + inject.length + " shelves");
    return body;
  });
}

function handleCanvas(body) {
  return Promise.all([fetchResume(), fetchRecent(), fetchByType("Movie"), fetchByType("Series")]).then(function (r) {
    var shelves = [];
    var resume = onlyAV(r[0].Items);
    var recent = onlyAV(r[1]);
    var movies = onlyAV(r[2].Items);
    var shows = onlyAV(r[3].Items);
    if (resume.length) shelves.push(buildShelf("emby.col.resume", "继续观看", "lockup", resume.map(buildItem)));
    if (recent.length) shelves.push(buildShelf("emby.col.recent", "最近添加", "brick", recent.map(buildItem)));
    if (movies.length) shelves.push(buildShelf("emby.col.movies", "电影", "brick", movies.map(buildItem)));
    if (shows.length) shelves.push(buildShelf("emby.col.shows", "剧集", "brick", shows.map(buildItem)));
    log("canvas built: " + shelves.length + " shelves");
    return { data: { canvas: buildCanvas(shelves), channels: (function () { var o = {}; o[CONFIG.brandId] = buildBrand(); return o; })() }, utsk: body.utsk };
  });
}

function handleDetail(body, embyId) {
  return embyGet(userPath("/Items/" + embyId + "?Fields=" + FIELDS)).then(function (e) {
    var isMovie = e.Type === "Movie";
    var id = ID_PREFIX + e.Id;
    var kind = isMovie ? "movie" : "show";
    var seconds = num(Math.round((e.RunTimeTicks || 0) / 10000000), 0);
    var pageUrl = "https://tv.apple.com/us/" + kind + "/" + slug(e.Name) + "/" + id;

    var pl = playableObject(e);
    pl.url = pageUrl + "?playableId=" + encodeURIComponent(pl.id);
    pl.serviceId = "emby.local";
    pl.serviceName = "Emby";
    pl.isItunes = false;
    pl.locales = [];
    pl.adLocales = [];
    pl.subtitledLocales = [];
    pl.closedCaptionedLocales = [];
    pl.sdhLocales = [];
    pl.audioTrackFormats = [];
    pl.audioTrackLocales = [];
    pl.primaryLocale = { displayName: "Chinese", locale: "zh" };
    pl.releaseDate = e.PremiereDate ? Date.parse(e.PremiereDate) : undefined;
    pl.images = { contentImage: img(embyImage(e.Id, "backdrop"), 3840, 2160) };

    var playables = {};
    playables[pl.id] = pl;

    var content = buildItem(e);
    // 详情页渲染强依赖这几项：缺 contentAvailability 会直接显示"内容不可用"
    content.duration = seconds;
    content.description = e.Overview || "";
    content.contentAvailability = { availabilityStatus: "Available" };
    content.url = pageUrl;
    content.isAppleOriginal = false;
    content.countriesOfOrigin = [];
    content.originalSpokenLanguages = [];
    content.seoNoIndex = false;
    content.rolesSummary = [];
    content.caption = undefined;
    content.playables = [pl];

    var channels = {};
    channels[CONFIG.brandId] = buildBrand();

    return {
      data: {
        badges: { hasSubtitles: true, hasClosedCaptions: true, videoQuality: "HD" },
        canvas: {
          debug: { isOptedOutForPersonalizedRecommendations: false },
          id: "uts.cvs.pp." + id,
          shelves: [],
          url: "https://tv.apple.com/us/room/uts.cvs.pp." + id,
        },
        channels: channels,
        content: content,
        contentPersonalizedInfo: {
          inUpNext: false,
          isAddToUpNextEnabled: true,
          isMarkAsWatchedEnabled: true,
          isWatched: false,
        },
        howToWatch: [
          {
            actions: ["Play"],
            channelId: CONFIG.brandId,
            playbackModes: ["Monoscopic"],
            versionPicker: false,
            versions: [{ playableId: pl.id, playbackModes: ["Monoscopic"] }],
          },
        ],
        playables: playables,
        smartPlayables: playables,
        upsellOffers: {},
      },
      utsk: body.utsk,
    };
  });
}

/* ============================ 入口 ============================ */

(function main() {
  var req = parseUrl($request.url);
  var path = req.path;
  var _ua = ($request && $request.headers) ? ($request.headers["User-Agent"] || $request.headers["user-agent"] || "") : "";
  var _ver = ($request && $request.url) ? (qs(parseUrl($request.url).query, "v") || "?") : "?";
  var _pfm = ($request && $request.url) ? (qs(parseUrl($request.url).query, "pfm") || "?") : "?";
  beacon("HIT " + path + " pfm=" + _pfm + " v=" + _ver + " ua=" + String(_ua).slice(0, 42));
  console.log("[emby-tv] hit " + path + " bodyLen=" + (($response && $response.body) ? String($response.body).length : "none"));
  var body;
  // 上游对伪造的 emby- 前缀 id 往往直接回 400 且 body 不是 JSON。
  // 这里不能因为解析失败就退出，否则完全由我们接管的端点（详情、分集）永远拿不到机会。
  try { body = JSON.parse($response.body || "{}"); } catch (e) { body = {}; }

  var job = null;

  if (path === "/uts/v3/configurations") {
    job = Promise.resolve(handleConfigurations(body));
  } else if (
    path === "/uts/v3/canvases/Roots/tahoma_watchnow" ||
    path === "/uts/v3/canvases/roots/tahoma_watchnow" ||
    path === "/uts/v3/canvases/Roots/watchNow"
  ) {
    job = handleWatchNow(body);
  } else if (path === "/uts/v3/channels") {
    job = Promise.resolve(handleChannels(body));
  } else if (path === "/uts/v3/canvases/Channels/" + CONFIG.brandId) {
    job = handleCanvas(body);
  } else if (path.indexOf("/uts/v3/shows/" + ID_PREFIX) === 0 && path.indexOf("/episodes") > 0) {
    job = handleEpisodes(body, path.split("/")[4]);
  } else if (path.indexOf("/uts/v3/contents/" + ID_PREFIX) === 0) {
    // personalized-flags 之类：上游对伪造 id 会回 400，直接给空结构更安全
    job = Promise.resolve({ data: {} });
  } else if (path.indexOf("/uts/v3/movies/" + ID_PREFIX) === 0 || path.indexOf("/uts/v3/shows/" + ID_PREFIX) === 0) {
    job = handleDetail(body, path.split("/").pop().replace(ID_PREFIX, ""));
  }

  if (!job) return $done($response);

  job.then(function (out) {
    $response.body = JSON.stringify(out);
    beacon("DONE " + path);
    // 上游可能回 4xx（缺参数等），我们接管后必须给 200，否则客户端丢弃内容
    $response.status = 200;
    if ($response.statusCode) $response.statusCode = 200;
    $response.headers = $response.headers || {};
    $response.headers["Content-Type"] = "application/json; charset=utf-8";
    // uts 默认 Cache-Control: private,max-age=7200，不改这里 TV app 两小时内不会重新拉，注入永远看不到
    $response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
    if ($response.headers["cache-control"]) $response.headers["cache-control"] = "no-store, no-cache, must-revalidate, max-age=0";
    if ($response.headers["content-type"]) $response.headers["content-type"] = "application/json; charset=utf-8";
    $done($response);
  }).catch(function (err) {
    log("error: " + err);
    $done($response);
  });
})();