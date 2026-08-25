/* ============================================================
 *  microCMS 連携（トップ / 新着情報一覧 / 詳細で共通利用）
 *  ------------------------------------------------------------
 *  ★設定はこのファイル1か所に集約しています（全ページ共通）。
 *   APIエンドポイント・サービスドメイン・APIキー・取得処理は
 *   すべてここを参照します。変更はここだけ直せばOKです。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ── 接続設定（★実際の値に合わせてください）────────────────
   *  SERVICE_DOMAIN … 管理画面URL https://<これ>.microcms.io の <これ>
   *                   ※値が違うと取得できません。まずここを確認。
   *  API_KEY        … GET（参照）専用のAPIキー。
   *                   ★実値はリポジトリにコミットしません。
   *                   下のプレースホルダー __MICROCMS_API_KEY__ は、
   *                   GitHub Actions がデプロイ時に Secrets の
   *                   MICROCMS_API_KEY から差し込みます
   *                   （.github/workflows/preview-pages.yml 参照）。
   *                   ※クライアント配信のため、公開後のJSからは閲覧可能に
   *                     なります。必ず GET 専用キーにしてください。
   *  NEWS_ENDPOINT  … microCMS の「API」ID（エンドポイント名）。
   * ------------------------------------------------------------ */
  var SERVICE_DOMAIN = 'naganawa-k'; // ← あなたのサービスドメイン（公開情報）
  var API_KEY        = '__MICROCMS_API_KEY__'; // ← デプロイ時にSecretsから注入（実値はコミットしない）
  var NEWS_ENDPOINT  = 'news';
  var WORKS_ENDPOINT = 'works'; // ← microCMS の「施工実績」API（エンドポイント）ID

  var API_BASE = 'https://' + SERVICE_DOMAIN + '.microcms.io/api/v1/';

  /* カテゴリー表示名 → タグ色クラス（既存デザインのクラスに対応） */
  var CATEGORY_CLASS = {
    'お知らせ': 'news-tag--info',
    '採用情報': 'news-tag--recruit',
    '会社情報': 'news-tag--company',
    'その他':   'news-tag--other'
  };

  /* ── 取得処理（全ページ共通）──────────────────────────── */
  function request(path) {
    return fetch(API_BASE + path, {
      headers: { 'X-MICROCMS-API-KEY': API_KEY }
    }).then(function (res) {
      if (!res.ok) throw new Error('microCMS ' + res.status + ' ' + res.statusText);
      return res.json();
    });
  }
  function fetchNewsList(limit) {
    return request(NEWS_ENDPOINT + '?orders=-publishDate,-publishedAt&limit=' + (limit || 100))
      .then(function (data) { return (data && data.contents) || []; });
  }
  function fetchNewsOne(id) {
    return request(NEWS_ENDPOINT + '/' + encodeURIComponent(id));
  }

  /* ── 公開日時の判定（新着・施工実績で共通）──────────────
   *  ・日本時間(Asia/Tokyo)基準。閲覧端末のタイムゾーンに依存しない。
   *  ・「年月日＋時刻」まで比較（絶対時刻で比較するので、ISO日時なら
   *    ブラウザのTZに関係なく正しく公開判定される）。
   *  ・公開日時フィールドの候補を優先順に解決
   *    （新着=publishDate 等 / 施工実績=date 等 / 共通=microCMS標準 publishedAt）。
   * ------------------------------------------------------------ */
  var PUBLISH_FIELDS = ['publishDate', 'publishAt', 'publishedDate', 'releaseDate', 'date', 'completionDate', 'completedDate', 'constructionDate', 'workDate', 'publishedAt', 'createdAt'];
  function toInstant(raw) {
    if (raw == null || raw === '') return null;
    raw = String(raw);
    // 日付のみ(YYYY-MM-DD)は日本時間の 00:00 として解釈（TZずれ防止）
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw = raw + 'T00:00:00+09:00';
    var t = new Date(raw).getTime();
    return isNaN(t) ? null : t;
  }
  function publishInstant(item) {
    for (var i = 0; i < PUBLISH_FIELDS.length; i++) {
      var t = toInstant(item[PUBLISH_FIELDS[i]]);
      if (t !== null) return t;
    }
    return null;
  }
  /* 日本時間で「公開済み」か（未来日時は false）。新着・施工実績で共通使用。 */
  function isPublished(item) {
    var t = publishInstant(item);
    if (t === null) return true; // 公開日時が全く無い場合のみ従来どおり表示
    return t <= Date.now();
  }
  /* 公開済みのみに絞り、公開日時の新しい順（時刻まで）に並べる */
  function publishedSorted(items) {
    return (items || []).filter(isPublished).sort(function (a, b) {
      return (publishInstant(b) || 0) - (publishInstant(a) || 0);
    });
  }
  /* 表示用 YYYY.MM.DD（日本時間で整形。閲覧端末のTZに依存しない） */
  function formatDateJST(item) {
    var t = publishInstant(item);
    if (t === null) return '';
    var p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '.' + p.month + '.' + p.day;
  }

  /* ── フィールド抽出（スキーマ差異に強く）──────────────── */
  function pickDate(item) { return formatDateJST(item); }
  /* ── カテゴリ抽出・比較（新着・施工実績で共通）──────────────
   *  microCMS のカテゴリは 文字列 / 配列（セレクト・複数選択）/
   *  オブジェクト（コンテンツ参照）のいずれでも返り得る。必ず
   *  「カテゴリ名の配列」に正規化して扱い、比較は trim + NFKC
   *  （全角半角のゆらぎ吸収）で行う。複数カテゴリのいずれかが一致
   *  すれば該当とみなす（＝1件が複数カテゴリを持っても取りこぼさない）。
   * ------------------------------------------------------------ */
  var WORKS_CAT_KEYS = ['category', 'type', 'workType', 'constructionType', 'kind', 'genre'];
  function extractCategories(raw) {
    if (raw == null || raw === '') return [];
    var arr = Array.isArray(raw) ? raw : [raw];
    var out = [];
    arr.forEach(function (v) {
      if (v == null || v === '') return;
      if (typeof v === 'string') { out.push(v); return; }
      if (typeof v === 'object') { var n = v.name || v.title || v.label || v.value || v.id || ''; if (n) out.push(n); return; }
      out.push(String(v));
    });
    return out;
  }
  function normCat(s) { return String(s == null ? '' : s).trim().normalize('NFKC'); }
  function categoryMatches(cats, active) {
    if (active === 'すべて' || active === '') return true;
    var a = normCat(active);
    for (var i = 0; i < cats.length; i++) { if (normCat(cats[i]) === a) return true; }
    return false;
  }
  function newsCategories(item) { return extractCategories(item.category); }
  function worksCategories(item) { return extractCategories(firstDefined(item, WORKS_CAT_KEYS)); }

  /* 表示用（タグ）：先頭カテゴリ名（前後空白除去） */
  function pickCategory(item) { var c = newsCategories(item); return c.length ? String(c[0]).trim() : ''; }
  function pickTitle(item) { return item.title || item.name || '（無題）'; }
  function pickBody(item) { return item.content || item.body || item.text || ''; }
  /* サムネイル画像URL：microCMSの画像フィールドは {url,height,width} で返る。
     未登録なら空文字（画像枠を出さない）。文字列で来た場合も許容。 */
  function pickThumbnailUrl(item) {
    var t = item.thumbnail;
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t === 'object' && t.url) return t.url;
    return '';
  }
  function categoryClass(cat) { return CATEGORY_CLASS[normCat(cat)] || CATEGORY_CLASS[cat] || 'news-tag--other'; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  /* ── 状態表示 ─────────────────────────────────────────── */
  function showLoading(el) { el.innerHTML = '<li class="news-loading">読み込み中...</li>'; }
  function showEmpty(el) { el.innerHTML = '<li class="news-empty">現在、お知らせはありません。</li>'; }

  /* ── 一覧の1件 <li> ───────────────────────────────────── */
  function itemHtml(item, hrefPrefix) {
    var date = pickDate(item);
    var cat = pickCategory(item);
    var title = pickTitle(item);
    var href = hrefPrefix + 'detail.html?id=' + encodeURIComponent(item.id);
    var tag = cat
      ? '<span class="news-tag ' + categoryClass(cat) + '">' + escapeHtml(cat) + '</span>'
      : '';
    return '<li class="news-item" data-category="' + escapeHtml(cat) + '">' +
      '<span class="news-date">' + escapeHtml(date) + '</span>' +
      tag +
      '<a href="' + href + '" class="news-title">' + escapeHtml(title) + '</a>' +
      '</li>';
  }
  function renderList(el, items, hrefPrefix) {
    if (!items || !items.length) { showEmpty(el); return; }
    el.innerHTML = items.map(function (it) { return itemHtml(it, hrefPrefix); }).join('');
  }

  /* ── トップページ：最新N件 ────────────────────────────── */
  function initTop(options) {
    options = options || {};
    var el = document.getElementById(options.listId || 'news-latest');
    if (!el) return;
    var hrefPrefix = options.hrefPrefix != null ? options.hrefPrefix : 'news/';
    var limit = options.limit || 3;
    showLoading(el);
    fetchNewsList(limit + 20) // 未来日時を除外するため多めに取得してから絞る
      .then(function (items) { renderList(el, publishedSorted(items).slice(0, limit), hrefPrefix); })
      .catch(function (err) { console.error('[microCMS] 取得に失敗しました:', err); showEmpty(el); });
  }

  /* ── 新着情報一覧：全件＋カテゴリー絞り込み ────────────── */
  function initList(options) {
    options = options || {};
    var el = document.getElementById(options.listId || 'news-list');
    if (!el) return;
    var hrefPrefix = options.hrefPrefix != null ? options.hrefPrefix : '';
    var buttons = Array.prototype.slice.call(
      document.querySelectorAll(options.filterSelector || '.works-filter__item')
    );
    var all = [];
    var active = 'すべて';

    function apply() {
      if (!all.length) { showEmpty(el); return; } // 全体0件 → 「現在、お知らせはありません。」
      var list = (active === 'すべて')
        ? all
        : all.filter(function (it) { return categoryMatches(newsCategories(it), active); });
      if (!list.length) { el.innerHTML = '<li class="news-empty">該当する記事はありません。</li>'; return; } // 全体はあるが該当カテゴリ0件
      renderList(el, list, hrefPrefix);
    }

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        active = (btn.textContent || '').trim();
        apply();
      });
    });

    showLoading(el);
    fetchNewsList(100)
      .then(function (items) {
        // 【一時的なデバッグ】カテゴリの実値・型を確認するため。確認後に削除します。
        try { console.log('[news] category sample:', items.slice(0, 8).map(function (it) { return { raw: it.category, norm: newsCategories(it) }; })); } catch (e) {}
        all = publishedSorted(items); apply(); // 公開済みのみ・公開日時順
      })
      .catch(function (err) { console.error('[microCMS] 取得に失敗しました:', err); showEmpty(el); });
  }

  /* ── 詳細ページ：?id= の1件を表示 ─────────────────────── */
  function initDetail(options) {
    options = options || {};
    var el = document.getElementById(options.rootId || 'news-detail');
    if (!el) return;
    var crumb = options.crumbId ? document.getElementById(options.crumbId) : null;
    var params = new URLSearchParams(global.location.search);
    var id = params.get('id');
    if (!id) {
      el.innerHTML = '<p class="news-empty">記事が指定されていません。</p>';
      return;
    }
    el.innerHTML = '<p class="news-loading">読み込み中...</p>';
    fetchNewsOne(id).then(function (item) {
      // 公開日時前は、URL直接アクセスでも表示しない（日本時間で判定）
      if (!isPublished(item)) {
        el.innerHTML = '<p class="news-empty">この記事はまだ公開されていません。</p>';
        return;
      }
      var date = pickDate(item);
      var cat = pickCategory(item);
      var title = pickTitle(item);
      var body = pickBody(item);
      var thumbUrl = pickThumbnailUrl(item);
      var tag = cat
        ? '<span class="news-tag ' + categoryClass(cat) + '">' + escapeHtml(cat) + '</span>'
        : '';
      // サムネイル画像：登録がある場合のみ、タイトル下・本文上に表示。
      // 未登録なら要素自体を出さない（空枠・壊れた画像アイコン・余白を残さない）。
      var thumbHtml = thumbUrl
        ? '<div class="news-detail-thumbnail-wrapper">' +
            '<img class="news-detail-thumbnail" src="' + escapeHtml(thumbUrl) + '"' +
            ' alt="' + escapeHtml(title) + '" loading="lazy" decoding="async">' +
          '</div>'
        : '';
      el.innerHTML =
        '<article class="news-article">' +
          '<div class="news-article-header">' +
            '<div class="news-article-meta">' +
              '<span class="news-date">' + escapeHtml(date) + '</span>' + tag +
            '</div>' +
            '<h1 class="news-article-title">' + escapeHtml(title) + '</h1>' +
          '</div>' +
          thumbHtml +
          '<div class="news-article-body">' + body + '</div>' +
        '</article>';
      // 画像の読み込みに失敗した場合はラッパーごと非表示（レイアウトを崩さない）。
      var thumbImg = el.querySelector('.news-detail-thumbnail');
      if (thumbImg) {
        thumbImg.addEventListener('error', function () {
          var w = thumbImg.closest ? thumbImg.closest('.news-detail-thumbnail-wrapper') : thumbImg.parentNode;
          if (w) w.style.display = 'none';
        });
      }
      // 本文中の table をスクロール用ラッパーで囲む（スマホ対応・全記事共通）
      var bodyEl = el.querySelector('.news-article-body');
      if (bodyEl) {
        Array.prototype.forEach.call(bodyEl.querySelectorAll('table'), function (tbl) {
          var parent = tbl.parentNode;
          if (parent && parent.classList && parent.classList.contains('news-table-wrap')) return;
          var wrap = global.document.createElement('div');
          wrap.className = 'news-table-wrap';
          parent.insertBefore(wrap, tbl);
          wrap.appendChild(tbl);
        });
      }
      if (crumb) crumb.textContent = title;
      global.document.title = title + '｜新着情報｜長縄工務店';
    }).catch(function (err) {
      console.error('[microCMS] 取得に失敗しました:', err);
      el.innerHTML = '<p class="news-empty">現在、お知らせはありません。</p>';
    });
  }

  /* ============================================================
   *  施工実績（works）microCMS 連携
   *  ------------------------------------------------------------
   *  ※ microCMS のフィールドIDが確定できない環境向けに、代表的な
   *    フィールドID候補を順に探して解決します（推測で1つに決め打ち
   *    せず、実スキーマに合わせて動くようにするため）。実際のIDは
   *    プレビューの Console ログ（initWorksList / initWorksDetail）で
   *    確認できます（確認後にログは削除）。
   *  カテゴリ表示名 → 色クラス（work-card__category--* / work-detail__category--*）
   * ============================================================ */
  var WORKS_CATEGORY_CLASS = { '舗装工事': 'paving', '土木工事': 'civil', 'その他': 'other' };

  function firstDefined(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  }
  function imgUrl(v) { // 画像フィールド値 → URL（{url}オブジェクト/文字列/配列に対応）
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === 'object') return v.url || '';
    return '';
  }
  function stripHtml(s) { return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function looksLikeHtml(s) { return /<[a-z][\s\S]*>/i.test(String(s)); }

  function worksTitle(item) { return firstDefined(item, ['title', 'name', 'workName', 'work_name', 'constructionName', 'projectName']) || '（無題）'; }
  function worksBody(item) { return firstDefined(item, ['content', 'body', 'description', 'detail', 'overview', 'text', 'worksContent', 'constructionContent']); }
  function worksLocation(item) { return firstDefined(item, ['location', 'place', 'area', 'address', 'site']); }
  /* 表示用（タグ）：先頭カテゴリ名（前後空白除去）。判定は categoryMatches を使用 */
  function worksCategory(item) { var c = worksCategories(item); return c.length ? String(c[0]).trim() : ''; }
  function worksImage(item) { return imgUrl(firstDefined(item, ['mainImage', 'main_image', 'mainimage', 'image', 'thumbnail', 'eyecatch', 'photo', 'mainPhoto'])); }
  /* 施工実績の表示日付：新着と同じ共通ロジック（日本時間・公開日時基準） */
  function worksDate(item) { return formatDateJST(item); }
  function worksGallery(item) {
    var g = firstDefined(item, ['gallery', 'photos', 'images', 'subImages', 'sub_images', 'constructionPhotos']);
    if (!g) return [];
    if (!Array.isArray(g)) g = [g];
    return g.map(imgUrl).filter(Boolean);
  }
  function worksCatClass(cat) { return WORKS_CATEGORY_CLASS[normCat(cat)] || WORKS_CATEGORY_CLASS[cat] || 'other'; }

  function fetchWorksList(limit) {
    // 公開中のみ返る（GET用APIキー）。orders は必ず存在する publishedAt を使用
    // （不明なフィールドを orders に渡すと microCMS が 400 を返すため）。
    return request(WORKS_ENDPOINT + '?limit=' + (limit || 100) + '&orders=-publishedAt')
      .then(function (data) { return (data && data.contents) || []; });
  }
  function fetchWorksOne(id) { return request(WORKS_ENDPOINT + '/' + encodeURIComponent(id)); }

  function worksCardHtml(item, hrefPrefix) {
    var title = worksTitle(item), cat = worksCategory(item), date = worksDate(item), img = worksImage(item);
    var descRaw = worksBody(item);
    var desc = descRaw ? truncate(stripHtml(descRaw), 60) : '';
    var href = hrefPrefix + 'detail.html?id=' + encodeURIComponent(item.id);
    var imageHtml = img
      ? '<div class="work-card__image"><img src="' + escapeHtml(img) + '" alt="' + escapeHtml(title) + '" loading="lazy" decoding="async"></div>'
      : '<div class="work-card__image work-card__image--noimg"></div>';
    var catHtml = cat ? '<span class="work-card__category work-card__category--' + worksCatClass(cat) + '">' + escapeHtml(cat) + '</span>' : '';
    return '<a class="work-card" href="' + href + '" data-category="' + escapeHtml(cat) + '">' +
        imageHtml +
        '<div class="work-card__body">' +
          catHtml +
          '<h3 class="work-card__title">' + escapeHtml(title) + '</h3>' +
          (desc ? '<p class="work-card__desc">' + escapeHtml(desc) + '</p>' : '') +
          (date ? '<p class="work-card__date">' + escapeHtml(date) + '</p>' : '') +
        '</div>' +
      '</a>';
  }

  /* 「Coming Soon」プレースホルダーのカード1枚分（既存デザインをそのまま流用） */
  function worksComingSoonCard() {
    return '<div class="work-card work-card--coming" aria-disabled="true">' +
        '<div class="work-card__image work-card__image--placeholder"><span class="work-card__coming">Coming Soon</span></div>' +
        '<div class="work-card__body">' +
          '<span class="work-card__category">施工実績</span>' +
          '<h3 class="work-card__title">施工実績を準備中です</h3>' +
          '<p class="work-card__date">掲載準備中</p>' +
        '</div>' +
      '</div>';
  }
  /* Coming Soon カードを n 枚ぶん連結して返す（n<=0 なら空文字） */
  function worksComingSoonCards(n) {
    var html = '';
    for (var i = 0; i < n; i++) html += worksComingSoonCard();
    return html;
  }

  /* 施工実績 一覧：microCMSから取得してカード表示＋カテゴリ絞り込み */
  function initWorksList(options) {
    options = options || {};
    var el = global.document.getElementById(options.gridId || 'works-grid');
    if (!el) return;
    var hrefPrefix = options.hrefPrefix != null ? options.hrefPrefix : '';
    var buttons = Array.prototype.slice.call(global.document.querySelectorAll(options.filterSelector || '.works-filter__item'));
    var all = [], active = 'すべて';
    function attachImgError() {
      Array.prototype.forEach.call(el.querySelectorAll('.work-card__image img'), function (im) {
        im.addEventListener('error', function () { im.style.display = 'none'; });
      });
    }
    var WORKS_MIN_SLOTS = 3; // 「すべて」表示の最小枠数（実績＋Coming Soonで必ず埋める）
    function apply() {
      if (active === 'すべて') {
        // 実際の施工実績（公開日/施工日の新しい順。all は publishedSorted 済み）を表示し、
        // 3枠に満たない分だけ Coming Soon カードで右側を埋める。
        //   0件→Coming×3 / 1件→実績1+Coming2 / 2件→実績2+Coming1 /
        //   3件→実績3のみ / 4件以上→実績すべて（Coming無し）
        var cards = all.map(function (it) { return worksCardHtml(it, hrefPrefix); }).join('');
        cards += worksComingSoonCards(WORKS_MIN_SLOTS - all.length); // 差が0以下なら何も足さない
        el.innerHTML = cards;
        attachImgError();
        return;
      }
      // カテゴリ選択時：Coming Soon は出さず、該当する実際の施工実績のみ表示。
      var list = all.filter(function (it) { return categoryMatches(worksCategories(it), active); });
      if (!list.length) { el.innerHTML = '<p class="works-empty">現在、このカテゴリーの施工実績はありません。</p>'; return; }
      el.innerHTML = list.map(function (it) { return worksCardHtml(it, hrefPrefix); }).join('');
      attachImgError();
    }
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        active = (btn.textContent || '').trim();
        apply();
      });
    });
    el.innerHTML = '<p class="works-loading">読み込み中...</p>';
    fetchWorksList(100).then(function (items) {
      // 【一時的なデバッグ】カテゴリの実フィールドID・値・型を確認するため。確認後に削除します。
      try { console.log('[works] 件数:', items.length, '／カテゴリ:', items.slice(0, 8).map(function (it) { return { raw: firstDefined(it, WORKS_CAT_KEYS), norm: worksCategories(it) }; }), '／先頭データ:', items[0]); } catch (e) {}
      all = publishedSorted(items); apply(); // 公開済みのみ・公開日時の新しい順
    }).catch(function (err) {
      console.error('[microCMS] works取得に失敗:', err);
      el.innerHTML = '<p class="works-empty">施工実績を読み込めませんでした。</p>';
    });
  }

  /* 施工実績 詳細：?id= の1件を取得して表示 */
  function initWorksDetail(options) {
    options = options || {};
    var el = global.document.getElementById(options.rootId || 'works-detail');
    if (!el) return;
    var crumb = options.crumbId ? global.document.getElementById(options.crumbId) : null;
    var params = new URLSearchParams(global.location.search);
    var id = params.get('id');
    if (!id) { el.innerHTML = '<p class="works-empty">施工実績が見つかりません。</p>'; return; }
    el.innerHTML = '<p class="works-loading">読み込み中...</p>';
    fetchWorksOne(id).then(function (item) {
      // 【一時的なデバッグ】実フィールドID確認用。確認後に削除します。
      try { console.log('[works detail] item:', item); } catch (e) {}
      // 公開日時前は、URL直接アクセスでも表示しない（日本時間で判定）
      if (!isPublished(item)) {
        el.innerHTML = '<p class="works-empty">この施工実績はまだ公開されていません。</p>';
        return;
      }
      var title = worksTitle(item), cat = worksCategory(item), date = worksDate(item);
      var img = worksImage(item), body = worksBody(item), loc = worksLocation(item), gallery = worksGallery(item);
      var meta = '';
      if (cat) meta += '<li class="work-detail__meta-item"><span class="work-detail__meta-label">工事種別</span><span class="work-detail__meta-value">' + escapeHtml(cat) + '</span></li>';
      if (loc) meta += '<li class="work-detail__meta-item"><span class="work-detail__meta-label">施工場所</span><span class="work-detail__meta-value">' + escapeHtml(loc) + '</span></li>';
      if (date) meta += '<li class="work-detail__meta-item"><span class="work-detail__meta-label">完成年月</span><span class="work-detail__meta-value">' + escapeHtml(date) + '</span></li>';
      var bodyHtml = body ? (looksLikeHtml(body) ? body : '<p>' + escapeHtml(body).replace(/\n/g, '<br>') + '</p>') : '';
      var galleryHtml = gallery.length
        ? '<h2 class="work-detail__section-title">施工写真</h2><div class="work-detail__gallery">' +
          gallery.map(function (u) { return '<figure class="work-detail__gallery-item"><img src="' + escapeHtml(u) + '" alt="' + escapeHtml(title) + ' 施工写真" loading="lazy"></figure>'; }).join('') +
          '</div>'
        : '';
      el.innerHTML =
        '<article class="work-detail">' +
          (cat ? '<span class="work-detail__category work-detail__category--' + worksCatClass(cat) + '">' + escapeHtml(cat) + '</span>' : '') +
          '<h1 class="work-detail__title">' + escapeHtml(title) + '</h1>' +
          (img ? '<div class="work-detail__main-image"><img src="' + escapeHtml(img) + '" alt="' + escapeHtml(title) + '"></div>' : '') +
          (meta ? '<ul class="work-detail__meta">' + meta + '</ul>' : '') +
          (bodyHtml ? '<h2 class="work-detail__section-title">工事内容</h2><div class="work-detail__content">' + bodyHtml + '</div>' : '') +
          galleryHtml +
        '</article>';
      if (crumb) crumb.textContent = title;
      global.document.title = title + '｜施工実績｜長縄工務店';
      // 画像読み込み失敗時は該当の枠ごと非表示（壊れた画像アイコンを出さない）
      Array.prototype.forEach.call(el.querySelectorAll('img'), function (im) {
        im.addEventListener('error', function () {
          var p = im.closest ? im.closest('.work-detail__main-image, .work-detail__gallery-item') : im.parentNode;
          if (p) p.style.display = 'none';
        });
      });
    }).catch(function (err) {
      console.error('[microCMS] works詳細の取得に失敗:', err);
      el.innerHTML = '<p class="works-empty">施工実績が見つかりません。</p>';
    });
  }

  global.NaganawaNews = {
    initTop: initTop,
    initList: initList,
    initDetail: initDetail,
    initWorksList: initWorksList,
    initWorksDetail: initWorksDetail,
    fetchNewsList: fetchNewsList,
    fetchNewsOne: fetchNewsOne,
    fetchWorksList: fetchWorksList,
    fetchWorksOne: fetchWorksOne
  };
})(window);
