import { describe, it, expect } from 'vitest';
import { hasForbiddenContent, stripEcho, postProcess, sanitize, applyPersonaFilters, isEcho } from '../src/utils/sentinel.js';

describe('hasForbiddenContent', () => {
  it('returns null for clean Chinese group reply', () => {
    expect(hasForbiddenContent('哈哈今天天气不错啊')).toBeNull();
    expect(hasForbiddenContent('笑死我了')).toBeNull();
    expect(hasForbiddenContent('不行了吧这也太搞了')).toBeNull();
  });

  it('detects claude as whole word', () => {
    expect(hasForbiddenContent('claude是真有个性')).toBe('claude');
    expect(hasForbiddenContent('我觉得Claude很厉害')).toBe('Claude');
  });

  it('does not false-positive on non-forbidden English words', () => {
    // "bot reply" used to false-trigger — must not
    expect(hasForbiddenContent('bot reply is here')).toBeNull();
    // "ai" as a substring in non-self-referential context
    expect(hasForbiddenContent('bai jiu hen hao he')).toBeNull();
  });

  it('detects 机器人', () => {
    expect(hasForbiddenContent('我只是一个机器人')).toBe('机器人');
  });

  it('detects 助手', () => {
    expect(hasForbiddenContent('我是一个AI助手，很高兴为您服务')).toBeTruthy();
  });

  it('detects 我来模仿 substring (not bare 模仿)', () => {
    expect(hasForbiddenContent('我来模仿他的风格')).toBe('我来模仿');
  });

  it('does NOT flag bare 模仿 in natural usage', () => {
    expect(hasForbiddenContent('没感觉出来模仿群友吗')).toBe(null);
  });

  it('detects 请问您', () => {
    expect(hasForbiddenContent('请问您需要我帮助做什么')).toBe('请问您');
  });

  it('detects 需要我帮', () => {
    expect(hasForbiddenContent('您需要我帮您做点什么吗')).toBe('需要我帮');
  });

  it('detects 我可以', () => {
    expect(hasForbiddenContent('我可以帮您生成回复')).toBe('我可以');
  });

  it('detects --- separator', () => {
    expect(hasForbiddenContent('攻击性有点高了\n---\n请问您需要我帮助做什么')).toBe('---');
  });

  it('detects soft-start 好的，', () => {
    expect(hasForbiddenContent('好的，我来帮您')).toBe('好的，');
  });

  it('does not false-positive "好的" without comma', () => {
    expect(hasForbiddenContent('好的哦然后呢')).toBeNull();
  });

  it('detects 描述太模糊 image leak', () => {
    expect(hasForbiddenContent('描述太模糊了锐评不了啥')).toBe('描述太模糊');
  });

  it('detects 图描述 image leak', () => {
    expect(hasForbiddenContent('图描述呢你发一下')).toBe('图描述');
  });

  it('detects 描述呢 image leak', () => {
    expect(hasForbiddenContent('这图描述呢你发一下')).toBeTruthy();
  });

  it('does not false-positive normal use of 描述', () => {
    // "描述" alone is not forbidden — only specific leak phrases
    expect(hasForbiddenContent('他描述得很清楚')).toBeNull();
  });
});

describe('stripEcho', () => {
  it('strips echo prefix when reply starts with long user message and has remainder', () => {
    const user = '攻击性有点高了, 福大哥在这个群不这么说话的（吧';
    const reply = `${user}\n---\n请问您需要我帮助做什么？`;
    expect(stripEcho(reply, user)).toBe('请问您需要我帮助做什么？');
  });

  it('does not strip when reply is short and matches trigger (valid echo response)', () => {
    expect(stripEcho('咪', '咪')).toBe('咪');
  });

  it('does not strip when user message is short (< 5 chars)', () => {
    expect(stripEcho('哈哈哈哈哈', '哈哈')).toBe('哈哈哈哈哈');
  });

  it('returns empty string when echo prefix exhausts reply', () => {
    const user = '这条消息很长超过五个字';
    expect(stripEcho(user, user)).toBe('');
  });

  it('strips leading dashes and spaces after echo', () => {
    const user = '攻击性有点高了，这不是福大哥的风格';
    const reply = `${user}\n--- \n这是Claude助手`;
    const result = stripEcho(reply, user);
    expect(result).toBe('这是Claude助手');
  });
});

describe('postProcess', () => {
  it('strips trailing Chinese period', () => {
    expect(postProcess('好的哦。')).toBe('好的哦');
  });

  it('strips multiple trailing periods', () => {
    expect(postProcess('哈哈。。')).toBe('哈哈');
  });

  it('leaves replies without trailing period unchanged', () => {
    expect(postProcess('笑死我了')).toBe('笑死我了');
    expect(postProcess('好哦！')).toBe('好哦！');
    expect(postProcess('真的假的？')).toBe('真的假的？');
  });

  it('strips trailing whitespace then period', () => {
    expect(postProcess('来了  。')).toBe('来了');
  });

  it('does not strip mid-sentence period', () => {
    expect(postProcess('他说。然后走了')).toBe('他说。然后走了');
  });

  it('strips [CQ:face,...] codes from output', () => {
    expect(postProcess('[CQ:face,id=178] 哈哈')).toBe('哈哈');
    expect(postProcess('哈哈 [CQ:face,id=14]')).toBe('哈哈');
    expect(postProcess('[CQ:face,id=178][CQ:face,id=14]')).toBe('');
  });

  it('strips [CQ:mface,...] codes (mface is banned — only learned [CQ:image] allowed)', () => {
    const mface = '[CQ:mface,type=6,emoji_id=123,key=abc,summary=哎]';
    expect(postProcess(mface)).toBe('');
    expect(postProcess('哈哈 ' + mface)).toBe('哈哈');
  });

  it('preserves [CQ:image,file=...] codes (learned stickers are allowed)', () => {
    const img = '[CQ:image,file=file:///D:/stickers/abc.jpg]';
    expect(postProcess(img)).toBe(img);
  });

  it('strips <skip> line from mixed multi-line reply', () => {
    expect(postProcess('又开始了\n<skip>')).toBe('又开始了');
  });

  it('strips all-<skip> reply to empty string', () => {
    expect(postProcess('<skip>\n<skip>\n<skip>')).toBe('');
  });

  it('strips <skip> line from middle of reply', () => {
    expect(postProcess('不接\n<skip>\n草')).toBe('不接\n草');
  });

  it('strips uppercase <SKIP>', () => {
    expect(postProcess('<SKIP>')).toBe('');
  });

  it('strips padded < skip >', () => {
    expect(postProcess('< skip >')).toBe('');
  });

  it('leaves normal reply unchanged', () => {
    expect(postProcess('正常回复')).toBe('正常回复');
  });

  // ── Hallucinated CQ image segments (observed in prod 2026-04-15) ──────

  it('strips hallucinated <CQ:image,...> angle-bracketed segment', () => {
    const hallu = '<CQ:image,file=09949142F28E32E37CE17D35F180DAAC.jpg,sub_type=1,url=https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=xxx>';
    expect(postProcess(hallu)).toBe('');
  });

  it('strips mixed text + hallucinated <CQ:image,...>', () => {
    expect(postProcess('笑死 <CQ:image,file=abc.jpg,url=https://x>')).toBe('笑死');
  });

  it('strips [CQ:image,...url=http...] hallucination but keeps local-file sticker', () => {
    const hallu = '[CQ:image,file=abc.jpg,sub_type=1,url=https://multimedia.nt.qq.com.cn/x]';
    expect(postProcess(hallu)).toBe('');
    // Learned local sticker must still pass
    const legit = '[CQ:image,file=file:///D:/stickers/abc.jpg]';
    expect(postProcess(legit)).toBe(legit);
  });

  it('strips truncated [CQ:image,...url=http...] fragments copied by mimic', () => {
    const truncated = '[CQ:image,file=abc.jpg,sub_type=0,url=https://multimedia.nt.qq.com/download?fileid=x,file_size=12';
    expect(postProcess(truncated)).toBe('');
    expect(postProcess(`笑死 ${truncated}`)).toBe('笑死');
  });

  it('strips leaked blockquote fragments from generated replies', () => {
    expect(postProcess('哼/blockquote')).toBe('哼');
    expect(postProcess('哼</blockquote>')).toBe('哼');
    expect(postProcess('<blockquote>哼')).toBe('哼');
  });

  it('strips any <CQ:...> variant (hallucinated at/face/whatever)', () => {
    expect(postProcess('<CQ:at,qq=123>')).toBe('');
    expect(postProcess('<CQ:face,id=14>')).toBe('');
    expect(postProcess('哈哈 <CQ:at,qq=123> 你看')).toBe('哈哈  你看');
  });

  // ── Leaked <skip> with leading/trailing junk (observed in prod 2026-04-15)

  it('drops line that is "..<skip>" (skip with leading dots)', () => {
    expect(postProcess('..<skip>')).toBe('');
  });

  it('drops line that is "<skip>.." (skip with trailing dots)', () => {
    expect(postProcess('<skip>..')).toBe('');
  });

  it('unwraps line with inline <skip> leaving real content', () => {
    // "嗯 <skip> 走了" — strip <skip>, keep the rest
    expect(postProcess('嗯 <skip> 走了')).toBe('嗯  走了');
  });
});

describe('sanitize', () => {
  it('strips hallucinated CQ image with url but preserves local-file sticker', () => {
    const hallu = '[CQ:image,file=abc.jpg,url=https://x]';
    expect(sanitize(hallu)).toBe('');
    const legit = '[CQ:image,file=file:///D:/stickers/abc.jpg]';
    expect(sanitize(legit)).toBe(legit);
  });

  it('strips <CQ:...> angle-bracket hallucinations', () => {
    expect(sanitize('<CQ:at,qq=123>')).toBe('');
  });

  it('strips [CQ:face,...] codes', () => {
    expect(sanitize('[CQ:face,id=178] test')).toBe('test');
  });

  it('does NOT strip [CQ:mface,...] — that belongs to persona filters', () => {
    const mface = '[CQ:mface,type=6,emoji_id=123,key=abc,summary=test]';
    expect(sanitize(mface)).toBe(mface);
  });

  it('does NOT strip trailing Chinese period — that belongs to persona filters', () => {
    expect(sanitize('hello。')).toBe('hello。');
  });

  it('strips <skip> lines', () => {
    expect(sanitize('hi\n<skip>\nbye')).toBe('hi\nbye');
  });
});

describe('applyPersonaFilters', () => {
  it('strips all mface when allowedMfaceKeys is null', () => {
    const mface = '[CQ:mface,type=6,emoji_id=123,key=abc,summary=test]';
    expect(applyPersonaFilters(mface, null)).toBe('');
  });

  it('keeps mface whose key is in the whitelist', () => {
    const mface = '[CQ:mface,type=6,emoji_id=123,key=abc,summary=test]';
    expect(applyPersonaFilters(mface, new Set(['abc']))).toBe(mface);
  });

  it('strips mface whose key is NOT in the whitelist', () => {
    const mface = '[CQ:mface,type=6,emoji_id=123,key=abc,summary=test]';
    expect(applyPersonaFilters(mface, new Set(['xyz']))).toBe('');
  });

  it('mixed: keeps whitelisted, strips non-whitelisted', () => {
    const keep = '[CQ:mface,type=6,emoji_id=1,key=good,summary=ok]';
    const strip = '[CQ:mface,type=6,emoji_id=2,key=bad,summary=no]';
    const result = applyPersonaFilters(`${keep} text ${strip}`, new Set(['good']));
    expect(result).toBe(`${keep} text`);
  });

  it('strips trailing Chinese period', () => {
    expect(applyPersonaFilters('hello。', null)).toBe('hello');
  });

  it('empty whitelist strips all mface', () => {
    const mface = '[CQ:mface,type=6,emoji_id=123,key=abc,summary=test]';
    expect(applyPersonaFilters(mface, new Set())).toBe('');
  });
});

describe('isEcho', () => {
  it('exact match with sufficient length → true', () => {
    expect(isEcho('瞧你糖的', '瞧你糖的')).toBe(true);
    expect(isEcho('今天天气不错吧', '今天天气不错吧')).toBe(true);
  });

  it('very short reply (< 4 normalized chars) → false (short reply guard)', () => {
    expect(isEcho('abc', 'abc')).toBe(false);
    expect(isEcho('好', '好')).toBe(false);
    expect(isEcho('嗯哦', '嗯哦')).toBe(false);
  });

  it('reply contains trigger with little extra content → true', () => {
    expect(isEcho('哈哈哈哈西瓜你好狠哈', '哈哈哈哈西瓜你好狠')).toBe(true);
  });

  it('reply is substring of trigger with enough length → true', () => {
    expect(isEcho('西瓜你好狠', '哈哈哈哈西瓜你好狠')).toBe(true);
  });

  it('genuinely different reply → false', () => {
    expect(isEcho('哈哈哈哈不是吧', '哈哈哈哈西瓜你好狠')).toBe(false);
  });

  it('reply is much longer than trigger → false', () => {
    expect(isEcho('瞧你糖的，其实今天发生了很多事情我都不知道怎么说', '瞧你糖的')).toBe(false);
  });

  it('empty trigger or reply → false', () => {
    expect(isEcho('', 'hello')).toBe(false);
    expect(isEcho('hello', '')).toBe(false);
  });
});

// UR-A #15: over-denial sentinel sweep
describe('hasForbiddenContent — UR-A over-denial phrases', () => {
  it('flags "我是真人"', () => {
    expect(hasForbiddenContent('我是真人！')).toBe('我是真人');
  });
  it('flags "我不是bot"', () => {
    expect(hasForbiddenContent('怎么可能我不是bot')).toBeTruthy();
  });
  it('flags "我不是ai" (case-insensitive)', () => {
    expect(hasForbiddenContent('我不是AI啦')).toBeTruthy();
  });
  it('flags "我不是机器人"', () => {
    // may short-circuit on 机器人 substring — either match is fine
    expect(hasForbiddenContent('我不是机器人，别乱说')).toBeTruthy();
  });
  it('flags "你说什么呢我是人"', () => {
    expect(hasForbiddenContent('你说什么呢我是人啊')).toBe('你说什么呢我是人');
  });
  it('does NOT flag "我是 bot" (允许坦然承认)', () => {
    expect(hasForbiddenContent('对啊 我是 bot')).toBeNull();
  });
});
