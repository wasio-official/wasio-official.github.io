/* ============================================================================
 * fuzzy.js —— 考点搜索的模糊匹配
 *
 * 解决的问题（按重要性）：
 *   1. 排序  现状 matchItems() 只做 include/exclude，完全不排序。
 *             输入「能量守」命中 92 条，目标可能排在第 63 位。
 *   2. 同音错别字  「霍耳效应」搜不到「霍尔效应」。
 *   3. 拼音检索  「guangshan」或「gsys」能搜到「光栅衍射」。
 *
 * 三个坑（都实测过，别改回去）：
 *
 *   A. 拼音必须按「词」算，不能按字算。
 *      逐字：光栅 → guang-zha  ✗   按词：guang-shan  ✓
 *      所以拼音数据在构建期算好（build.py 的 build_pinyin_data），
 *      前端不重新算标签拼音，只算 query 的。
 *
 *   B. query 必须支持「多读音展开」。
 *      字表里「栅」的第一个读音是 zha，用户输「光栅」直接转会得到
 *      guangzha（错），得靠展开成 guangzha/guangshan 两个变体，
 *      再用 guangshan 去命中。这是字表存多读音的唯一理由。
 *
 *   C. 匹配目标必须是「标签段」而不是整条路径。
 *      segs 表存的是每一级名称（如「光栅衍射」），
 *      整条路径（光学/波动光学/衍射/光栅衍射）由前端拼接判断。
 *      这样拼音表只有 82KB 而不是 235KB。
 * ========================================================================== */

(function (global) {
  "use strict";

  /* ------------------------------------------------------------ 音节切分 */

  // 拼音音节表：用于把「连写的拼音串」切开。
  // 用户可能输入 guangshan（连写），而库里的拼音也是连写的，
  // 判断子串关系其实不需要切分 —— 但**首字母匹配**需要知道词边界。
  // 这里只在需要时用，且不必完备（只求对常见音节正确）。
  const SYLLABLES = new Set([
    "a","ai","an","ang","ao","ba","bai","ban","bang","bao","bei","ben","beng","bi","bian","biao","bie","bin","bing","bo","bu",
    "ca","cai","can","cang","cao","ce","cen","ceng","cha","chai","chan","chang","chao","che","chen","cheng","chi","chong","chou","chu","chua","chuai","chuan","chuang","chui","chun","chuo","ci","cong","cou","cu","cuan","cui","cun","cuo",
    "da","dai","dan","dang","dao","de","dei","den","deng","di","dia","dian","diao","die","ding","diu","dong","dou","du","duan","dui","dun","duo",
    "e","ei","en","eng","er","fa","fan","fang","fei","fen","feng","fo","fou","fu",
    "ga","gai","gan","gang","gao","ge","gei","gen","geng","gong","gou","gu","gua","guai","guan","guang","gui","gun","guo",
    "ha","hai","han","hang","hao","he","hei","hen","heng","hong","hou","hu","hua","huai","huan","huang","hui","hun","huo",
    "ji","jia","jian","jiang","jiao","jie","jin","jing","jiong","jiu","ju","juan","jue","jun",
    "ka","kai","kan","kang","kao","ke","ken","keng","kong","kou","ku","kua","kuai","kuan","kuang","kui","kun","kuo",
    "la","lai","lan","lang","lao","le","lei","leng","li","lia","lian","liang","liao","lie","lin","ling","liu","lo","long","lou","lu","luan","lue","lun","luo","lv",
    "ma","mai","man","mang","mao","me","mei","men","meng","mi","mian","miao","mie","min","ming","miu","mo","mou","mu",
    "na","nai","nan","nang","nao","ne","nei","nen","neng","ni","nian","niang","niao","nie","nin","ning","niu","nong","nou","nu","nuan","nue","nuo","nv",
    "o","ou","pa","pai","pan","pang","pao","pei","pen","peng","pi","pian","piao","pie","pin","ping","po","pou","pu",
    "qi","qia","qian","qiang","qiao","qie","qin","qing","qiong","qiu","qu","quan","que","qun",
    "ran","rang","rao","re","ren","reng","ri","rong","rou","ru","ruan","rui","run","ruo",
    "sa","sai","san","sang","sao","se","sen","seng","sha","shai","shan","shang","shao","she","shei","shen","sheng","shi","shou","shu","shua","shuai","shuan","shuang","shui","shun","shuo","si","song","sou","su","suan","sui","sun","suo",
    "ta","tai","tan","tang","tao","te","teng","ti","tian","tiao","tie","ting","tong","tou","tu","tuan","tui","tun","tuo",
    "wa","wai","wan","wang","wei","wen","weng","wo","wu",
    "xi","xia","xian","xiang","xiao","xie","xin","xing","xiong","xiu","xu","xuan","xue","xun",
    "ya","yan","yang","yao","ye","yi","yin","ying","yo","yong","you","yu","yuan","yue","yun",
    "za","zai","zan","zang","zao","ze","zei","zen","zeng","zha","zhai","zhan","zhang","zhao","zhe","zhei","zhen","zheng","zhi","zhong","zhou","zhu","zhua","zhuai","zhuan","zhuang","zhui","zhun","zhuo","zi","zong","zou","zu","zuan","zui","zun","zuo",
  ]);

  /**
   * 把连写拼音切成音节。切不动就原样返回。
   * 只用于首字母匹配，允许不完美。
   */
  function splitSyllables(py) {
    const out = [];
    let i = 0;
    while (i < py.length) {
      let matched = "";
      // 最长匹配 6 个字母（chuang 是 6）
      for (let L = Math.min(6, py.length - i); L >= 1; L--) {
        const seg = py.slice(i, i + L);
        if (SYLLABLES.has(seg)) { matched = seg; break; }
      }
      if (!matched) {
        // 切不动（英文单词等），整段当作一个音节，跳到非字母处
        let j = i;
        while (j < py.length && /[a-z]/.test(py[j])) j++;
        if (j === i) j = i + 1;
        out.push(py.slice(i, j));
        i = j;
        continue;
      }
      out.push(matched);
      i += matched.length;
    }
    return out;
  }

  /* ------------------------------------------------------------ 拼音转换 */

  /**
   * 把任意 query 转成「拼音变体」数组。
   *
   * 多音字展开：每个汉字用字表里的所有读音，组合起来（上限 cap 种）。
   * 例：「光栅」→ ['guangzha', 'guangshan']（栅有 zha/shan 两读）
   * 展开数超上限时只取首选读音，避免组合爆炸。
   */
  function queryReadings(q, chars, cap) {
    cap = cap || 8;
    const parts = [];
    for (const ch of q) {
      if (chars[ch] !== undefined) {
        parts.push(String(chars[ch]).split("/").filter(Boolean));
      } else if (/[A-Za-z0-9]/.test(ch)) {
        parts.push([ch.toLowerCase()]);
      } else if (/[\u4e00-\u9fff]/.test(ch)) {
        // 字表里没有的汉字：原样保留，至少还能按字形匹配
        parts.push([ch]);
      }
      // 其余字符（空格、符号）直接跳过
    }
    if (!parts.length) return [];

    let total = 1;
    for (const p of parts) { total *= p.length; if (total > cap) break; }

    if (total > cap) {
      // 组合太多：只用首选读音
      return [parts.map((p) => p[0]).join("")];
    }
    // 笛卡尔积
    let acc = [""];
    for (const p of parts) {
      const next = [];
      for (const prefix of acc) for (const r of p) next.push(prefix + r);
      acc = next;
    }
    return acc;
  }

  /** 首字母串（用于 gsys → 光栅衍射 这类检索） */
  function initialsOf(py) {
    return splitSyllables(py).map((s) => s[0]).join("");
  }

  /* ------------------------------------------------------------ 匹配打分 */

  // 分数越高越靠前。这些阈值是调出来的经验值。
  const SCORE = {
    EXACT: 1000,      // query 与标签段完全相同
    PREFIX: 800,      // 标签段以 query 开头
    WORD: 600,        // 命中某个完整词的拼音（query 是完整音节的组合）
    SUBSTR: 400,      // 普通子串命中
    INITIAL: 200,     // 首字母命中
  };

  /**
   * 给一条「候选段」对 query 打分。返回 0 表示不匹配。
   *
   * hay      标签段的原文（小写）
   * hayPy    标签段的拼音（构建期算好）
   * readings query 的拼音变体
   * qLow      query 原文（小写）
   * qInit     query 的首字母串
   */
  function scoreSeg(hay, hayPy, readings, qLow, qInit) {
    // 构建期没算出拼音的段（字表未覆盖等）给个空串兜底，
    // 否则下面的 startsWith/includes 会抛 TypeError。
    hayPy = hayPy || "";

    // 1) 原文精确
    if (hay === qLow) return SCORE.EXACT;

    // 2) 拼音精确（同音词，如 霍耳效应 == 霍尔效应）
    for (const r of readings) {
      if (r && r === hayPy) return SCORE.EXACT - 50;
    }

    // 3) 原文前缀
    if (hay.startsWith(qLow)) return SCORE.PREFIX;

    // 4) 拼音前缀
    for (const r of readings) {
      if (r && r.length >= 2 && hayPy.startsWith(r)) return SCORE.PREFIX - 50;
    }

    // 5) 原文子串
    if (qLow.length >= 2 && hay.includes(qLow)) return SCORE.WORD;

    // 6) 拼音子串（核心：同音错别字走这里）
    for (const r of readings) {
      if (r && r.length >= 2 && hayPy.includes(r)) return SCORE.SUBSTR;
    }

    // 7) 首字母。
    //
    // 这条路噪音很大：'hexy' 既可能是「霍尔效应」也可能是
    // 「化学势」(huaxue shi → hxs，不对) —— 但仍然会有一堆段恰好
    // 首字母包含 'hexy'（如「循环效率」huán? 不，是 xunhuan…）。
    // 实测「化学势/几何相位/循环效率」都排在「霍尔效应」前面，
    // 因为它们更短。所以这里额外要求：
    //   首字母命中必须**从头开始**（是词首缩写，而不是中间的某段），
    //   且 query 的音节数要够多（≥3），否则单/双字母缩写噪音太大。
    if (qInit && qInit.length >= 3) {
      const hayInit = initialsOf(hayPy);
      if (hayInit === qInit) return SCORE.INITIAL + 100;
      if (hayInit.startsWith(qInit)) return SCORE.INITIAL + 50;
    }

    return 0;
  }

  /**
   * 在候选标签段集合里找出匹配项，按分数降序返回。
   *
   * segs: {段: 拼音}
   * 返回: [{seg, score}]
   */
  function matchSegs(q, segs, chars) {
    const qLow = String(q || "").trim().toLowerCase();
    if (!qLow) return [];

    // 纯 ASCII（拼音/首字母）输入要单独走一条路：
    // queryReadings() 会把字母当成「原样保留的字」，
    // 得到的串直接和段落拼音比子串 —— 对 gsys 这种首字母缩写无效
    // （段落拼音里没有 'gsys' 这个子串）。
    const isAscii = /^[a-z0-9]+$/.test(qLow);

    const readings = queryReadings(qLow, chars);
    const qInit = readings.length ? initialsOf(readings[0]) : "";

    const hits = [];
    for (const seg in segs) {
      const hay = seg.toLowerCase();
      const hayPy = segs[seg] || "";
      let sc;

      if (isAscii) {
        sc = scoreAsciiQuery(hay, hayPy, qLow);
      } else {
        sc = scoreSeg(hay, hayPy, readings, qLow, qInit);
      }
      if (sc > 0) hits.push({ seg, score: sc });
    }

    // 同分时：短的段优先（更可能是「考点」而不是长描述）
    hits.sort((a, b) => b.score - a.score || a.seg.length - b.seg.length);
    return hits;
  }

  /**
   * 纯字母 query 的打分。
   * 三种可能：完整拼音 / 拼音前缀 / 首字母缩写。
   */
  function scoreAsciiQuery(hay, hayPy, q) {
    if (!hayPy) return 0;
    const hayInit = initialsOf(hayPy);

    // 首字母完全相等最优先（gsys → 光栅衍射）
    if (hayInit === q) return SCORE.EXACT;
    if (hayInit.startsWith(q)) return SCORE.PREFIX;
    // 拼音完全相等（guangshanyanshe）
    if (hayPy === q) return SCORE.EXACT - 20;
    if (hayPy.startsWith(q)) return SCORE.PREFIX - 20;
    // 拼音子串（shaoyanshe 这类片段）
    if (q.length >= 3 && hayPy.includes(q)) return SCORE.WORD;
    // 首字母子串：要求够长，否则噪音大
    if (q.length >= 3 && hayInit.includes(q)) return SCORE.SUBSTR;
    return 0;
  }

  global.Fuzzy = {
    matchSegs,
    queryReadings,
    initialsOf,
    splitSyllables,
    scoreSeg,
    scoreAsciiQuery,
    SCORE,
  };
})(window);
