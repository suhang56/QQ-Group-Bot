import { describe, it, expect } from 'vitest';
import { hasForbiddenContent, stripEcho, postProcess, isEcho } from '../src/utils/sentinel.js';

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

  it('detects 模仿 substring', () => {
    expect(hasForbiddenContent('我来模仿他的风格')).toBe('模仿');
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

  it('preserves [CQ:mface,...] codes (mface is allowed)', () => {
    const mface = '[CQ:mface,type=6,emoji_id=123,key=abc,summary=哎]';
    expect(postProcess(mface)).toBe(mface);
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
});

describe('isEcho', () => {
  it('exact match → true', () => {
    expect(isEcho('abc', 'abc')).toBe(true);
    expect(isEcho('瞧你糖的', '瞧你糖的')).toBe(true);
  });

  it('reply contains trigger with little extra content → true', () => {
    expect(isEcho('哈哈哈哈西瓜你好狠哈', '哈哈哈哈西瓜你好狠')).toBe(true);
  });

  it('reply is substring of trigger → true', () => {
    expect(isEcho('你好狠', '哈哈哈哈西瓜你好狠')).toBe(true);
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
