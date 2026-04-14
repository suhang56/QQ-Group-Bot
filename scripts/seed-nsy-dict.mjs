import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/bot.db');
const now = Math.floor(Date.now() / 1000);

const facts = [
  [
    '声优昵称字典 核心',
    '群内最常用的女声优 (nsy) 昵称简写（按 mention 频率排）：ykn = 相羽あいな Aiba Aina（Roselia 凑友希那 CV），群里被提及最多，是群本命；ygfn = 羊宮妃那 Yamiya Fuina（MyGO 高松灯 CV），外号 🐑 / 羊姐；qmyc = 青木陽菜 Aoki Haruna（MyGO 要乐奈 CV），外号 🌞；lsl = 立石凛 Tateishi Rin（MyGO 千早爱音 CV）；jtty = 進藤天音 Shindou Amane（Morfonica 倉田真白 CV），"八岐大蛇"塌房事件当事人；鼓子 = 林鼓子 Hayashi Koko（MyGO 椎名立希 CV）。',
  ],
  [
    '声优昵称字典 Ave Mujica',
    'Ave Mujica 五人的 CV 群里常直呼日文姓：高尾 = 高尾奏音（若叶睦 / Doloris CV）最高频；渡瀬 = 渡瀬結月（三角初華 / Mortis CV）；岩田 = 岩田陽葵（八幡海鳴 / Amoris CV）；戸川 相关戏中人由戸川さきこ 饰（Oblivionis）；にゃむ 一般指 祐天寺若麦 / Timoris（佐佐木李子 CV）。',
  ],
  [
    '声优昵称字典 Poppin Party',
    'ppp 五人 CV 群里称呼：愛美 Aimi = 户山香澄 CV（主唱）；大塚紗 = 大塚紗英 = 花园多惠 CV；西本 = 西本里美 = 牛込里美 CV；大橋 = 大橋彩香 = 山吹沙绫 CV；伊藤彩 = 伊藤彩沙 = 市谷有咲 CV（在群里也高频）。',
  ],
  [
    '声优昵称字典 Roselia',
    'Roselia 五人 CV：ykn = 相羽あいな = 凑友希那 CV（群最本命）；工藤晴香 = 冰川纱夜 CV；中島由貴 = 今井莉莎 CV；櫻川めぐ = 宇田川亚子 CV；志崎樺音 = 白金燐子 CV。',
  ],
  [
    '声优昵称字典 其它',
    '其它 BanG Dream 声优群内称呼：上坂 = 上坂堇 = Pastel*Palettes 白鹭千圣 CV；伊藤美 = 伊藤美来 = HHW 弦卷心 CV；田所 = 田所梓 = HHW 濑田薰 CV；内田秀 = HHW 北泽育美 CV；前島 = 前島亜美 = Pastel*Palettes 丸山彩 CV；小澤 = 小澤亞李 = Pastel*Palettes 冰川日菜 CV；中島爱 = Pastel*Palettes 大和麻弥 CV；西尾夕香 = Morfonica 广町七深 CV；加藤英 = 加藤英美里 = Afterglow 上原绯玛丽 CV；佐倉 = 佐倉綾音 = Afterglow 美竹兰 CV；幡 = Pastel*Palettes 若宫伊芙 CV（幡大森春花）。',
  ],
  [
    '声优昵称字典 通用词',
    'nsy = 女声優 (生放泛称)；nsyc = 女声优痴（嗦声优的人自嘲或互相调侃）；群内使用"nsy"单独出现多数指 ygfn 或 ykn 视语境而定；"你推哪个 nsy" 是群内考 bot / 刚认识的人的标准问句，回 ykn / ygfn 都是安全答。',
  ],
  [
    '声优昵称字典 表情与代称',
    '🐑 = ygfn（羊宫妃那的羊）；🌞 = qmyc（青木陽菜的陽）；羊姐 = 对 ygfn 的亲切称；姐 单独使用看语境可指 ykn（年龄最大）。看到 "羊" / "🐑" 都是指 ygfn 不是真羊。',
  ],
];

const stmt = db.prepare(
  "INSERT INTO learned_facts (group_id, topic, fact, source_user_id, source_user_nickname, source_msg_id, bot_reply_id, confidence, status, created_at, updated_at) VALUES (?, ?, ?, NULL, '[deep-tune:2026-04-14]', NULL, NULL, 0.95, 'active', ?, ?)"
);

for (const [topic, fact] of facts) {
  const r = stmt.run('958751334', topic, fact, now, now);
  console.log('inserted id', r.lastInsertRowid, '-', topic);
}
