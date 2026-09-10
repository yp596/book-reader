import { describe, it, expect } from 'vitest';
import { normalizeTags, parseTags, matchesTags, countTags } from './note-tags';

describe('normalizeTags', () => {
  it('中英文逗号/分号/空白都作为分隔符', () => {
    expect(normalizeTags('小说,科幻；读书 笔记')).toBe('小说,科幻,读书,笔记');
  });

  it('去重且保持首次出现顺序', () => {
    expect(normalizeTags('b,a,b,c,a')).toBe('b,a,c');
  });

  it('清理首尾与重复空白', () => {
    expect(normalizeTags('  科幻 , , 文学  ')).toBe('科幻,文学');
  });

  it('丢弃超长项（防误贴整段文字）', () => {
    const long = 'x'.repeat(30);
    expect(normalizeTags(`科幻,${long},文学`)).toBe('科幻,文学');
  });

  it('空值与纯分隔符返回空串', () => {
    expect(normalizeTags('')).toBe('');
    expect(normalizeTags(null)).toBe('');
    expect(normalizeTags(undefined)).toBe('');
    expect(normalizeTags(' , ;  ')).toBe('');
  });
});

describe('parseTags', () => {
  it('解析为数组', () => {
    expect(parseTags('小说,科幻')).toEqual(['小说', '科幻']);
  });

  it('空值返回空数组', () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags('')).toEqual([]);
  });
});

describe('matchesTags', () => {
  it('未选标签时不过滤', () => {
    expect(matchesTags('小说', [])).toBe(true);
    expect(matchesTags('', [])).toBe(true);
  });

  it('交集语义：选中标签需全部命中', () => {
    expect(matchesTags('小说,科幻', ['小说'])).toBe(true);
    expect(matchesTags('小说,科幻', ['小说', '科幻'])).toBe(true);
    expect(matchesTags('小说,科幻', ['小说', '历史'])).toBe(false);
  });

  it('无标签的笔记在筛选时被排除', () => {
    expect(matchesTags('', ['小说'])).toBe(false);
    expect(matchesTags(null, ['小说'])).toBe(false);
  });

  it('接受数组形式输入', () => {
    expect(matchesTags(['小说', '科幻'], ['科幻'])).toBe(true);
  });
});

describe('countTags', () => {
  it('统计频次并按频次降序', () => {
    const out = countTags(['小说,科幻', '小说', '小说,历史', null]);
    expect(out[0]).toEqual({ tag: '小说', count: 3 });
    // 同频项顺序依赖 locale，这里只校验集合与计数
    const rest = out.slice(1);
    expect(rest.map(x => x.tag).sort()).toEqual(['历史', '科幻'].sort());
    expect(rest.every(x => x.count === 1)).toBe(true);
  });

  it('全部为空时返回空数组', () => {
    expect(countTags([null, '', undefined])).toEqual([]);
  });
});
