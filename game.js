(() => {
  'use strict';

  // ---- 定数 ----
  const WORLD_W = 360;       // ゲーム内の横幅（論理座標）
  const BH = 30;             // ブロックの高さ
  const START_W = 200;       // 最初のブロック幅
  const PERFECT = 6;         // パーフェクト判定の許容ズレ
  const GROW = 10;           // 3連続パーフェクト以降に伸びる幅
  const GRAVITY = 1600;
  const RANKS = [
    [0, '見習い大工 🔨'],
    [10, '一人前の職人 🧱'],
    [20, 'ベテラン棟梁 🏠'],
    [35, 'ビル建築家 🏢'],
    [50, 'タワー職人 🗼'],
    [70, 'スカイツリー級 🌤'],
    [100, '雲の上の人 ☁️'],
    [150, '宇宙建築家 🚀'],
    [250, '積みの神 👑'],
  ];
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24]; // ペンタトニック
  const SITE_URL = 'https://tsumitower.github.io/'; // シェアに付けるWeb版のURL
  // きせかえ: best=自己ベスト段数, total=累計段数 で解放
  const SKINS = [
    { id: 'color', name: 'カラフル' },
    { id: 'brick', name: 'レンガ', need: { best: 10 } },
    { id: 'pancake', name: 'パンケーキ', need: { best: 20 } },
    { id: 'book', name: '本', need: { total: 300 } },
    { id: 'sushi', name: 'お寿司', need: { best: 35 } },
    { id: 'gold', name: '黄金', need: { best: 60 } },
  ];

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const ui = {
    hud: $('hud'), score: $('score'), combo: $('combo'), toast: $('toast'),
    title: $('title'), titleBest: $('titleBest'),
    over: $('over'), finalScore: $('finalScore'), rank: $('rank'), newBest: $('newBest'),
    overLabel: $('overLabel'), overStats: $('overStats'), modeLabel: $('modeLabel'),
    dailyBtn: $('dailyBtn'), dailyInfo: $('dailyInfo'), home: $('homeBtn'),
    worldRank: $('worldRank'), ranking: $('ranking'), rankRule: $('rankRule'), myName: $('myName'),
    reroll: $('rerollBtn'), rankList: $('rankList'), rankStatus: $('rankStatus'), rankClose: $('rankClose'),
    titleRankBtn: $('titleRankBtn'), overRankBtn: $('overRankBtn'),
    retry: $('retryBtn'), share: $('shareBtn'), mute: $('muteBtn'),
    unlock: $('unlockMsg'), skins: $('skins'), skinGrid: $('skinGrid'),
    skinClose: $('skinClose'), titleSkinBtn: $('titleSkinBtn'), overSkinBtn: $('overSkinBtn'),
  };

  // ---- 保存 ----
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tsumi.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('tsumi.' + k, JSON.stringify(v)); } catch { /* 無視 */ } },
  };
  let best = store.get('best', 0);
  let muted = store.get('muted', false);
  let total = store.get('total', 0);
  let skin = store.get('skin', 'color');

  function isUnlocked(sk, b = best, t = total) {
    if (!sk.need) return true;
    return sk.need.best ? b >= sk.need.best : t >= sk.need.total;
  }
  function needText(sk) {
    if (sk.need.best) return `ベスト${sk.need.best}段で解放<br>（あと${sk.need.best - best}段）`;
    return `累計${sk.need.total}段で解放<br>（あと${sk.need.total - total}段）`;
  }
  if (!isUnlocked(SKINS.find((k) => k.id === skin) || {})) skin = 'color';

  // ---- デイリーチャレンジ ----
  // 日付から乱数の種を作るので、同じ日なら全員が同じ展開で遊ぶ
  const DAILY_MODS = [
    { id: 'normal', name: 'ノーマル' },
    { id: 'speed', name: 'ハイスピード' },
    { id: 'narrow', name: 'ほそほそ' },
    { id: 'random', name: 'きまぐれ' },
  ];
  function mulberry32(a) {
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function today() {
    const d = new Date();
    const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    return {
      key: dateKey(d),
      yesterday: dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)),
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      seed,
      // ルールは日替わりで順番に回す（乱数だと同じルールが続きやすい）
      mod: DAILY_MODS[Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5) % DAILY_MODS.length],
    };
  }
  function dailyRec(day) {
    const r = store.get('daily', null);
    return r && r.date === day.key ? r : { date: day.key, best: 0, tries: 0 };
  }
  function streakNow(day) {
    const st = store.get('streak', { last: '', count: 0 });
    return st.last === day.key || st.last === day.yesterday ? st.count : 0;
  }

  // ---- 世界ランキング (Supabase) ----
  // 名前は自由入力にせず単語の組み合わせにする（不適切な名前が出ないように）
  const ADJ = ['はやい', 'しずかな', 'まっかな', 'ねむい', 'つよい', 'ふわふわ', 'きらきら', 'のんびり',
    'ゆかいな', 'あおい', 'ちいさな', 'でっかい', 'まじめな', 'はらぺこ', 'ごきげん', 'ナゾの'];
  const NOUN = ['大工', 'ペンギン', '職人', 'パンダ', '忍者', 'ロボ', 'コック', 'うさぎ',
    '建築家', 'ねこ', 'くま', 'おばけ', 'たぬき', '王様', 'カエル', 'ハムスター'];
  const CFG = window.TSUMI_CONFIG || {};
  const online = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const rand16 = () => Math.floor(Math.random() * 16);
  let playerId = store.get('player', null);
  if (!playerId) {
    playerId = window.crypto && crypto.randomUUID ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = Math.random() * 16 | 0;
        return (ch === 'x' ? r : (r & 3) | 8).toString(16);
      });
    store.set('player', playerId);
  }
  let myName = store.get('name', null);
  if (!myName) { myName = [rand16(), rand16()]; store.set('name', myName); }
  const nameOf = (a, n) => ADJ[a] + NOUN[n];

  async function rpc(fn, args) {
    const headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseAnonKey };
    // 旧形式の anon key (JWT) は Authorization にも付ける。新形式の publishable key は apikey だけ
    if (!CFG.supabaseAnonKey.startsWith('sb_')) headers.Authorization = `Bearer ${CFG.supabaseAnonKey}`;
    const res = await fetch(`${CFG.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  // 今日の自己ベストを送って [順位, 人数] を返す。未プレイなら null
  async function submitDaily(d) {
    const rec = dailyRec(d);
    if (!online || rec.best < 1) return null;
    const rows = await rpc('submit_daily_score', {
      p_day: d.key, p_player: playerId, p_adj: myName[0], p_noun: myName[1], p_score: rec.best,
    });
    return rows[0] ? [rows[0].pos, rows[0].total] : null;
  }

  // ---- サウンド (WebAudio, 素材ファイル不要) ----
  let actx = null;
  function audio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, dur = 0.15, type = 'sine', vol = 0.2, slide = 0) {
    if (muted || state !== 'play' && state !== 'over') return;
    const a = audio(); if (!a) return;
    const t = a.currentTime;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  const sfx = {
    place() { tone(180, 0.12, 'triangle', 0.25, -80); },
    perfect(c) {
      const n = SCALE[Math.min(c - 1, SCALE.length - 1)];
      const f = 440 * Math.pow(2, n / 12);
      tone(f, 0.25, 'sine', 0.22);
      tone(f * 2, 0.18, 'sine', 0.06);
    },
    grow() { tone(880, 0.08, 'square', 0.06); setTimeout(() => tone(1320, 0.12, 'square', 0.06), 70); },
    over() { tone(300, 0.6, 'sawtooth', 0.12, -220); },
    milestone() { [0, 4, 7, 12].forEach((n, i) => setTimeout(() => tone(523 * Math.pow(2, n / 12), 0.2, 'triangle', 0.15), i * 80)); },
  };

  function buzz(ms) {
    if (state !== 'play' && state !== 'over') return;
    const h = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (h) { h.impact({ style: ms > 20 ? 'HEAVY' : 'LIGHT' }).catch(() => {}); return; }
    if (navigator.vibrate) navigator.vibrate(ms);
  }

  // ---- 画面サイズ ----
  let cssW = 0, cssH = 0, dpr = 1, s = 1, ox = 0, baseY = 0;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cssW = window.innerWidth; cssH = window.innerHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    s = Math.min(cssW, 520) / WORLD_W;
    ox = (cssW - WORLD_W * s) / 2;
    baseY = cssH * 0.78;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- ゲーム状態 ----
  let state = 'title';
  let stack, moving, debris, effects, cam, score, combo, maxCombo, hueBase, shake, overAt;
  let mode = 'normal', day = today(), rng = Math.random;
  function reset() {
    const daily = mode === 'daily';
    rng = daily ? mulberry32(day.seed) : Math.random;
    hueBase = rng() * 360;
    const w0 = daily && day.mod.id === 'narrow' ? 140 : START_W;
    stack = [{ x: (WORLD_W - w0) / 2, w: w0, level: 0, hue: hueBase }];
    debris = []; effects = [];
    cam = 0; score = 0; combo = 0; maxCombo = 0; shake = 0;
    spawn();
    ui.score.textContent = '0';
    ui.combo.textContent = '';
  }

  function hueAt(level) { return (hueBase + level * 7) % 360; }

  function spawn() {
    const top = stack[stack.length - 1];
    const level = stack.length;
    const r1 = rng(), r2 = rng(); // 毎回同じ数だけ使い、全員が同じ展開になるようにする
    const daily = mode === 'daily';
    const kimagure = daily && day.mod.id === 'random';
    const fromLeft = kimagure ? r1 < 0.5 : level % 2 === 1;
    let speed = Math.min(150 + score * 5, 460);
    if (daily && day.mod.id === 'speed') speed = Math.min(speed * 1.3 + 40, 520);
    if (kimagure) speed *= 0.75 + r2 * 0.5;
    moving = {
      w: top.w,
      x: fromLeft ? -top.w : WORLD_W,
      dir: fromLeft ? 1 : -1,
      speed, level, hue: hueAt(level),
    };
  }

  function drop() {
    const top = stack[stack.length - 1];
    const m = moving;
    const diff = m.x - top.x;
    const L = Math.max(m.x, top.x);
    const R = Math.min(m.x + m.w, top.x + top.w);
    const overlap = R - L;
    const y = m.level * BH;

    if (overlap <= 0) {
      debris.push(makeDebris(m.x, y, m.w, m.hue, m.dir * 60));
      moving = null;
      gameOver();
      return;
    }

    let placed;
    if (Math.abs(diff) <= PERFECT) {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
      let w = top.w, x = top.x;
      if (combo >= 3) {
        const nw = Math.min(START_W, w + GROW);
        x -= (nw - w) / 2; w = nw;
        if (nw > top.w) sfx.grow();
      }
      placed = { x, w, level: m.level, hue: m.hue };
      effects.push({ type: 'ring', x, w, y, t: 0 });
      sfx.perfect(combo);
      buzz(15);
      ui.combo.textContent = combo >= 2 ? `PERFECT ×${combo}` : 'PERFECT!';
    } else {
      combo = 0;
      placed = { x: L, w: overlap, level: m.level, hue: m.hue };
      // はみ出した部分を落とす
      if (m.x < top.x) debris.push(makeDebris(m.x, y, top.x - m.x, m.hue, -80));
      if (m.x + m.w > top.x + top.w) debris.push(makeDebris(top.x + top.w, y, m.x + m.w - (top.x + top.w), m.hue, 80));
      sfx.place();
      buzz(8);
      ui.combo.textContent = '';
    }

    stack.push(placed);
    score++;
    ui.score.textContent = score;
    shake = 4;

    if (state !== 'play') { ui.score.textContent = '0'; ui.combo.textContent = ''; }
    else if (score % 25 === 0) { toast(`${score}段 突破！`); sfx.milestone(); }
    else if (mode === 'daily' && dailyRec(day).best > 0 && score === dailyRec(day).best) toast('今日のベストに並んだ！');
    else if (mode === 'normal' && best > 0 && score === best) toast('自己ベストに並んだ！');
    else if (combo === 5 || combo === 10 || combo === 20) toast(combo === 20 ? '神業！！' : combo === 10 ? '超絶テク！' : 'すごい！');

    spawn();
  }

  function makeDebris(x, y, w, hue, vx) {
    return { x, y, w, hue, level: Math.round(y / BH), vx: vx + (Math.random() - 0.5) * 40, vy: 60, rot: 0, vr: (vx > 0 ? 1 : -1) * (1 + Math.random() * 2) };
  }

  let toastTimer = 0;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.remove('show');
    void ui.toast.offsetWidth;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1000);
  }

  function rankFor(n) {
    let r = RANKS[0][1];
    for (const [min, name] of RANKS) if (n >= min) r = name;
    return r;
  }

  function gameOver() {
    state = 'over';
    overAt = performance.now();
    sfx.over();
    buzz(40);
    shake = 10;
    const prevBest = best, prevTotal = total;
    let isBest, stats;
    if (mode === 'daily') {
      // デイリーは自己ベストには入れず、今日の記録と連続日数を更新
      const rec = dailyRec(day);
      isBest = score > rec.best;
      rec.best = Math.max(rec.best, score);
      rec.tries++;
      store.set('daily', rec);
      const st = store.get('streak', { last: '', count: 0 });
      if (st.last !== day.key) {
        st.count = st.last === day.yesterday ? st.count + 1 : 1;
        st.last = day.key;
        store.set('streak', st);
      }
      stats = `今日のベスト: ${rec.best}段 ／ 挑戦${rec.tries}回<br>🔥 ${st.count}日連続プレイ中`;
    } else {
      isBest = score > best;
      if (isBest) { best = score; store.set('best', best); }
      stats = `ベスト: ${best}段 ／ 最大コンボ: ${maxCombo}`;
    }
    total += score; store.set('total', total);
    store.set('plays', store.get('plays', 0) + 1);
    const unlocked = SKINS.filter((k) => !isUnlocked(k, prevBest, prevTotal) && isUnlocked(k));

    setTimeout(() => {
      ui.hud.classList.add('hidden');
      ui.finalScore.textContent = score;
      ui.rank.textContent = rankFor(score);
      ui.overLabel.textContent = mode === 'daily' ? `DAILY ${day.label}「${day.mod.name}」` : 'GAME OVER';
      ui.overStats.innerHTML = stats;
      ui.newBest.textContent = mode === 'daily' ? '🎉 今日のベスト更新！' : '🎉 自己ベスト更新！';
      ui.newBest.classList.toggle('hidden', !(isBest && score > 0));
      ui.unlock.textContent = unlocked.length ? `🎁 新しいきせかえ「${unlocked.map((k) => k.name).join('」「')}」が解放！` : '';
      ui.unlock.classList.toggle('hidden', !unlocked.length);
      ui.overSkinBtn.classList.toggle('glow', unlocked.length > 0);
      ui.over.classList.remove('hidden');
    }, 900);

    ui.worldRank.classList.toggle('hidden', !(online && mode === 'daily' && dailyRec(day).best > 0));
    if (online && mode === 'daily') {
      ui.worldRank.textContent = '🌏 ランキングに送信中…';
      submitDaily(day)
        .then((r) => { ui.worldRank.textContent = r ? `🌏 今日の世界ランキング ${r[0]}位 / ${r[1]}人` : ''; })
        .catch(() => { ui.worldRank.textContent = '🌏 通信できなかったので、あとでランキング画面から送信します'; });
    }
  }

  function start(m = mode) {
    audio();
    mode = m;
    day = today();
    reset();
    state = 'play';
    ui.title.classList.add('hidden');
    ui.over.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    ui.modeLabel.textContent = mode === 'daily' ? `DAILY「${day.mod.name}」` : '';
  }

  function goTitle() {
    mode = 'normal';
    state = 'title';
    ui.over.classList.add('hidden');
    renderTitle();
    ui.title.classList.remove('hidden');
    reset();
  }

  function renderTitle() {
    ui.titleBest.textContent = best;
    const d = today(), rec = dailyRec(d), st = streakNow(d);
    ui.dailyInfo.textContent = `今日のルール「${d.mod.name}」` +
      (rec.tries ? ` ／ ベスト${rec.best}段` : ' ／ 未挑戦') +
      (st ? ` ／ 🔥${st}日連続` : '');
    ui.dailyBtn.classList.toggle('glow', !rec.tries);
  }

  // ---- 入力 ----
  const ready = () => performance.now() - overAt > 1200; // ゲームオーバー直後の誤タップ防止
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'play' && moving) drop();
  });
  ui.title.addEventListener('pointerdown', (e) => { e.preventDefault(); start('normal'); });
  ui.dailyBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); start('daily'); });
  $('privacyLink').addEventListener('pointerdown', (e) => e.stopPropagation()); // タイトルのタップでゲームが始まらないように
  ui.retry.addEventListener('click', () => { if (ready()) start(); });
  ui.home.addEventListener('click', () => { if (ready()) goTitle(); });
  ui.share.addEventListener('click', async () => {
    const text = mode === 'daily'
      ? `つみつみタワー デイリー ${day.label}「${day.mod.name}」で${score}段！🔥${streakNow(day)}日連続 #つみつみタワー`
      : `つみつみタワーで${score}段積んだ！【${rankFor(score)}】最大コンボ${maxCombo} #つみつみタワー`;
    try {
      if (navigator.share) await navigator.share({ text, url: SITE_URL });
      else { await navigator.clipboard.writeText(`${text}\n${SITE_URL}`); toast('コピーしました'); }
    } catch { /* キャンセル */ }
  });
  // ---- きせかえ画面 ----
  let skinFrom = null;
  function openSkins(from) {
    skinFrom = from;
    from.classList.add('hidden');
    renderSkins();
    ui.skins.classList.remove('hidden');
  }
  function renderSkins() {
    ui.skinGrid.innerHTML = '';
    for (const sk of SKINS) {
      const open = isUnlocked(sk);
      const card = document.createElement('button');
      card.className = 'skin-card' + (open ? '' : ' locked') + (sk.id === skin ? ' selected' : '');
      const cv = document.createElement('canvas');
      const pw = 120, ph = 84, r = Math.min(window.devicePixelRatio || 1, 3);
      cv.width = pw * r; cv.height = ph * r;
      const c = cv.getContext('2d');
      c.setTransform(r, 0, 0, r, 0, 0);
      const bh = 20;
      [[20, 80], [26, 72], [18, 76]].forEach(([x, w], i) => {
        paint(c, sk.id, x, ph - 8 - bh * (i + 1), w, bh, (hueBase + i * 25) % 360, i);
      });
      card.appendChild(cv);
      const name = document.createElement('span');
      name.className = 'skin-name';
      name.textContent = open ? sk.name : '🔒 ' + sk.name;
      card.appendChild(name);
      if (!open) {
        const need = document.createElement('span');
        need.className = 'skin-need';
        need.innerHTML = needText(sk);
        card.appendChild(need);
      }
      card.addEventListener('click', () => {
        if (!open) return;
        skin = sk.id; store.set('skin', skin);
        renderSkins();
      });
      ui.skinGrid.appendChild(card);
    }
  }
  ui.titleSkinBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); openSkins(ui.title); });
  ui.overSkinBtn.addEventListener('click', () => { ui.overSkinBtn.classList.remove('glow'); openSkins(ui.over); });
  ui.skinClose.addEventListener('click', () => {
    ui.skins.classList.add('hidden');
    skinFrom.classList.remove('hidden');
  });

  // ---- ランキング画面 ----
  let rankFrom = null;
  function openRanking(from) {
    rankFrom = from;
    from.classList.add('hidden');
    ui.ranking.classList.remove('hidden');
    loadRanking();
  }
  async function loadRanking() {
    const d = today();
    ui.rankRule.textContent = `${d.label}「${d.mod.name}」`;
    ui.myName.textContent = nameOf(myName[0], myName[1]);
    ui.rankList.innerHTML = '';
    ui.rankStatus.textContent = '読み込み中…';
    try {
      // 送れていない記録や名前の変更もここで反映する
      const mine = await submitDaily(d);
      const rows = await rpc('get_daily_ranking', { p_day: d.key, p_player: playerId });
      ui.rankList.innerHTML = '';
      for (const r of rows) addRankRow(r.pos, nameOf(r.adj, r.noun), r.score, r.is_me);
      if (mine && !rows.some((r) => r.is_me)) {
        addRankRow('…', '', '', false);
        addRankRow(mine[0], nameOf(myName[0], myName[1]), dailyRec(d).best, true);
      }
      ui.rankStatus.textContent = rows.length
        ? (mine ? `参加 ${mine[1]}人` : 'デイリーチャレンジを遊ぶとランキングに載ります')
        : 'まだ誰もいません。一番乗りしよう！';
    } catch {
      ui.rankStatus.textContent = '通信できませんでした。電波のよいところで開き直してください';
    }
  }
  function addRankRow(pos, name, score, me) {
    const li = document.createElement('li');
    if (me) li.className = 'me';
    const medal = { 1: '🥇', 2: '🥈', 3: '🥉' }[pos];
    for (const [cls, text] of [['pos', medal || pos], ['name', name], ['pts', score === '' ? '' : `${score}段`]]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      li.appendChild(span);
    }
    ui.rankList.appendChild(li);
  }
  ui.reroll.addEventListener('click', () => {
    myName = [rand16(), rand16()];
    store.set('name', myName);
    loadRanking();
  });
  ui.rankClose.addEventListener('click', () => {
    ui.ranking.classList.add('hidden');
    rankFrom.classList.remove('hidden');
  });
  ui.titleRankBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); openRanking(ui.title); });
  ui.overRankBtn.addEventListener('click', () => openRanking(ui.over));
  if (!online) {
    ui.titleRankBtn.classList.add('hidden');
    ui.overRankBtn.classList.add('hidden');
  }

  function renderMute() { ui.mute.textContent = muted ? '🔇' : '🔊'; }
  ui.mute.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    muted = !muted; store.set('muted', muted); renderMute();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    e.preventDefault();
    if (!ui.skins.classList.contains('hidden') || !ui.ranking.classList.contains('hidden')) return;
    if (state === 'title') start();
    else if (state === 'play' && moving) drop();
    else if (state === 'over') ui.retry.click();
  });

  // ---- 更新 ----
  function update(dt) {
    if (state === 'play' && moving) {
      moving.x += moving.dir * moving.speed * dt;
      const min = -moving.w * 0.85, max = WORLD_W - moving.w * 0.15;
      if (moving.x > max) { moving.x = max; moving.dir = -1; }
      if (moving.x < min) { moving.x = min; moving.dir = 1; }
    }

    // タイトル画面ではゆっくり自動で積むデモ
    if (state === 'title') {
      if (!moving) reset();
      moving.x += moving.dir * moving.speed * dt;
      const top = stack[stack.length - 1];
      if (stack.length >= 40) reset();
      else if (Math.abs(moving.x - top.x) < 3) drop();
      const min = -moving.w * 0.85, max = WORLD_W - moving.w * 0.15;
      if (moving.x > max) { moving.x = max; moving.dir = -1; }
      if (moving.x < min) { moving.x = min; moving.dir = 1; }
    }

    const target = Math.max(0, (stack.length - 5) * BH);
    cam += (target - cam) * Math.min(1, dt * 5);

    for (const d of debris) {
      d.vy += GRAVITY * dt;
      d.x += d.vx * dt;
      d.y -= d.vy * dt;
      d.rot += d.vr * dt;
    }
    debris = debris.filter((d) => d.y > cam - 2000);

    for (const f of effects) f.t += dt;
    effects = effects.filter((f) => f.t < 0.5);

    shake *= Math.pow(0.001, dt);
  }

  // ---- 描画 ----
  const sx = (x) => ox + x * s;
  const sy = (y) => baseY - (y - cam) * s;

  function drawBlock(x, y, w, hue, level, alpha = 1) {
    ctx.globalAlpha = alpha;
    paint(ctx, skin, sx(x), sy(y + BH), w * s, BH * s, hue, level);
    ctx.globalAlpha = 1;
  }

  function rr(c, X, Y, W, H, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(X, Y, W, H, Math.min(r, W / 2, H / 2));
    else c.rect(X, Y, W, H);
  }

  const SUSHI = [
    { fish: '#ff8a5c', stripe: '#ffd2bd' }, // サーモン
    { fish: '#d7263d', stripe: '#ee5d70' }, // マグロ
    { fish: '#f7cf3d', nori: true },        // 玉子
    { fish: '#eef3f5', stripe: '#b9cad3' }, // イカ
  ];

  // ブロック1個を (X,Y) 左上・幅W・高さH のスクリーン座標に描く
  function paint(c, id, X, Y, W, H, hue, level) {
    switch (id) {
      case 'brick': {
        c.fillStyle = '#b4532f';
        c.fillRect(X, Y, W, H);
        c.fillStyle = 'rgba(255,255,255,.12)';
        c.fillRect(X, Y, W, H * 0.15);
        c.strokeStyle = '#ead9c2';
        c.lineWidth = Math.max(1, H * 0.07);
        c.beginPath();
        c.moveTo(X, Y + H / 2); c.lineTo(X + W, Y + H / 2);
        c.moveTo(X, Y + H); c.lineTo(X + W, Y + H);
        const bl = H * 1.6;
        for (let row = 0; row < 2; row++) {
          const off = ((level + row) % 2) * bl / 2;
          for (let lx = X + off; lx < X + W; lx += bl) {
            if (lx <= X) continue;
            c.moveTo(lx, Y + row * H / 2); c.lineTo(lx, Y + (row + 1) * H / 2);
          }
        }
        c.stroke();
        break;
      }
      case 'pancake': {
        c.fillStyle = '#a85d22';
        rr(c, X, Y, W, H, H * 0.45); c.fill();
        c.fillStyle = '#f2c26b';
        rr(c, X + H * 0.08, Y + H * 0.2, W - H * 0.16, H * 0.55, H * 0.25); c.fill();
        if (level % 6 === 5) { // ときどきバター
          c.fillStyle = '#fff3a6';
          c.fillRect(X + W / 2 - H * 0.4, Y - H * 0.15, H * 0.8, H * 0.35);
        }
        break;
      }
      case 'sushi': {
        const k = SUSHI[level % SUSHI.length];
        c.fillStyle = '#fbfaf3';
        rr(c, X, Y + H * 0.42, W, H * 0.58, H * 0.25); c.fill();
        c.fillStyle = '#e4dfd0';
        for (let gx = X + H * 0.3; gx < X + W - 2; gx += H * 0.55) {
          c.fillRect(gx, Y + H * (0.62 + ((gx * 7) % 3) * 0.08), 2, 2);
        }
        c.save();
        rr(c, X, Y, W, H * 0.55, H * 0.3); c.fillStyle = k.fish; c.fill();
        c.clip();
        if (k.stripe) {
          c.strokeStyle = k.stripe; c.lineWidth = H * 0.1;
          c.beginPath();
          for (let lx = X - H; lx < X + W; lx += H * 0.6) { c.moveTo(lx, Y + H * 0.55); c.lineTo(lx + H * 0.6, Y); }
          c.stroke();
        }
        c.restore();
        if (k.nori) {
          const nw = Math.min(W * 0.3, H * 0.7);
          c.fillStyle = '#1f2a24';
          c.fillRect(X + W / 2 - nw / 2, Y, nw, H);
        }
        break;
      }
      case 'book': {
        c.fillStyle = `hsl(${hue},45%,38%)`;
        c.fillRect(X, Y, W, H);
        c.fillStyle = 'rgba(255,255,255,.12)';
        c.fillRect(X, Y, W, H * 0.18);
        c.fillStyle = '#e9c46a';
        const bw = Math.max(2, H * 0.12);
        if (W > bw * 6) {
          c.fillRect(X + W * 0.07, Y, bw, H);
          c.fillRect(X + W * 0.93 - bw, Y, bw, H);
        }
        c.fillStyle = 'rgba(255,255,255,.8)';
        c.fillRect(X + W * 0.3, Y + H * 0.32, W * 0.4, H * 0.36);
        break;
      }
      case 'gold': {
        const g = c.createLinearGradient(0, Y, 0, Y + H);
        g.addColorStop(0, '#fff1a8'); g.addColorStop(0.45, '#e8b10e'); g.addColorStop(1, '#9c6400');
        c.fillStyle = g;
        c.fillRect(X, Y, W, H);
        c.save();
        c.beginPath(); c.rect(X, Y, W, H); c.clip();
        const px = X + ((level * 53) % 100) / 100 * W;
        c.fillStyle = 'rgba(255,255,255,.45)';
        c.beginPath();
        c.moveTo(px, Y + H); c.lineTo(px + H * 0.5, Y + H); c.lineTo(px + H * 1.1, Y); c.lineTo(px + H * 0.6, Y);
        c.fill();
        c.restore();
        break;
      }
      default: {
        c.fillStyle = `hsl(${hue},70%,58%)`;
        c.fillRect(X, Y, W, H);
        c.fillStyle = `hsl(${hue},80%,72%)`;
        c.fillRect(X, Y, W, H * 0.22);
        c.fillStyle = `hsl(${hue},60%,42%)`;
        c.fillRect(X, Y + H * 0.82, W, H * 0.18);
      }
    }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 空: 高く積むほど色が変わり、やがて宇宙へ
    const height = stack ? stack.length : 0;
    const space = Math.min(1, Math.max(0, (height - 60) / 60));
    const h = hueAt(height);
    const g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, `hsl(${(h + 30) % 360},${45 - space * 25}%,${62 - space * 52}%)`);
    g.addColorStop(1, `hsl(${h},${50 - space * 20}%,${80 - space * 55}%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cssW, cssH);

    if (space > 0) {
      ctx.fillStyle = `rgba(255,255,255,${space * 0.8})`;
      for (let i = 0; i < 60; i++) {
        const x = (i * 9301 + 49297) % 233280 / 233280 * cssW;
        const y = ((i * 4973 + 1234) % 10007 / 10007 * cssH + cam * 0.1 * s) % cssH;
        ctx.fillRect(x, y, 2, 2);
      }
    }

    if (!stack) return;

    ctx.save();
    if (shake > 0.2) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

    // 地面
    const groundY = sy(0);
    if (groundY < cssH) {
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(0, groundY, cssW, cssH - groundY);
    }

    // 画面内のブロックだけ描く
    const first = Math.max(0, Math.floor((cam - (cssH - baseY) / s) / BH) - 1);
    for (let i = first; i < stack.length; i++) {
      const b = stack[i];
      drawBlock(b.x, b.level * BH, b.w, b.hue, b.level);
    }

    for (const d of debris) {
      const cx = sx(d.x + d.w / 2), cy = sy(d.y + BH / 2);
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(d.rot); ctx.translate(-cx, -cy);
      drawBlock(d.x, d.y, d.w, d.hue, d.level, 0.9);
      ctx.restore();
    }

    if (moving) drawBlock(moving.x, moving.level * BH, moving.w, moving.hue, moving.level);

    for (const f of effects) {
      const p = f.t / 0.5, pad = p * 22;
      ctx.strokeStyle = `rgba(255,255,255,${1 - p})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(sx(f.x) - pad, sy(f.y + BH) - pad, f.w * s + pad * 2, BH * s + pad * 2);
    }

    ctx.restore();
  }

  // ---- ループ ----
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  renderTitle();
  renderMute();
  reset();
  requestAnimationFrame(loop);
})();
