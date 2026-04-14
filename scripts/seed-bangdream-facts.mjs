import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/bot.db');
const now = Math.floor(Date.now() / 1000);

const facts = [
  [
    '邦多利 Our Notes 游戏',
    'BanG Dream! Our Notes 是 Bushiroad 新推的手游，2026 年发行（全球版由 bilibili 发行），含 5 个 band 共 25 个角色：MyGO / Ave Mujica / Mugendai Mewtype / millsage / Ikka Dumb Rock!（后三个是新 band）。Beta 测试 2026/3/1-5/17。',
  ],
  [
    '邦多利 新 band',
    'Our Notes 带来了 3 个新 band：Mugendai Mewtype（无限大 mewtype）/ millsage / Ikka Dumb Rock! — 这些不在老的 Poppin Party/Afterglow/Pastel Palettes/Roselia/HHW/Morfonica/RAS/MyGO/Ave Mujica 九团清单里，是新企划加入的。',
  ],
  [
    '邦多利 10周年 live',
    'BanG Dream 10th Anniversary LIVE「In the name of BanG Dream!」2026/2/28 在横浜 K Arena 举行，共 7 个 band 上台：Ave Mujica / Morfonica / Mugendai Mewtype / MyGO / Poppin Party / RAISE A SUILEN / Roselia。Pastel Palettes 和 HHW 没上。Roselia 的 setlist 包括 ZEAL OF PROUD / BLACK SHOUT / FIRE BIRD / VIOLET LINE / PASSIONATE ANTHEM。',
  ],
  [
    'MyGO Ave Mujica 续篇',
    'MyGO!!!!! / Ave Mujica 电视动画续篇「The Die is Cast」已官方确认，2027 年 1 月在 NTV + 29 个关联台开播。不是 2026 年，是 2027 年 1 月。',
  ],
  [
    'Roselia 2025-26 单曲',
    'Roselia 最新两张单曲是 Dazzle the Destiny（16th）和 Requiem for Fate（17th），初回限定版含 live 抽选券。',
  ],
  [
    'Roselia 亚洲巡演',
    'Roselia ASIA TOUR「Neuweltfahrt」是她们第二次亚洲巡演：2025/11/22 大阪 Ookini Arena Maishima 开场，新加坡 12/5，首尔 12/24，台北 12/26，大阪 2026/1/16-17 返场，东京 Garden Theater 2026/2/14-15 收官。',
  ],
  [
    '羊宫妃那 最新活动',
    'ygfn 羊宮妃那 2025-2026 近期出演：千歳くんはラムネ瓶のなか（内田夕空）2025/10/7-12/30 + 2026/3 续篇、名探偵プリキュア（マシュタン）2026/2/1 起、ホテル・インヒューマンズ S2（桐原柴）、ワンダンス（ワンダ）2025/10 起、Dragon Quest I&II 声演、朗读剧『汝、星のごとく』2026/5/30、广播节目「羊宮妃那のこもれびじかん」2025/4/6 起于文化放送。',
  ],
  [
    'FIRE BIRD 再确认',
    'FIRE BIRD 属 Roselia（在 10th Anniversary LIVE 2026/2/28 横浜场的 Roselia setlist 里再次登台）。不是 RAS。群友拷问时回 Roselia 的就对。',
  ],
];

const stmt = db.prepare(
  "INSERT INTO learned_facts (group_id, topic, fact, source_user_id, source_user_nickname, source_msg_id, bot_reply_id, confidence, status, created_at, updated_at) VALUES (?, ?, ?, NULL, '[online:websearch-2026-04-14]', NULL, NULL, 0.9, 'active', ?, ?)"
);

for (const [topic, fact] of facts) {
  const r = stmt.run('958751334', topic, fact, now, now);
  console.log('inserted id', r.lastInsertRowid, '-', topic);
}
