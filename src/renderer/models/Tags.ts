export interface WordTag {
  normalized: string;
  word: string;
  redirect: string;
  freq: number;
  priority: number;
  category: number;
}

export const inf = 1e9;

export function normalize(word: string): [string, number[]] {
  let result = '';
  const mapping: number[] = [];
  const complexMedials: any = {
    ㅘ: 'ㅗㅏ',
    ㅙ: 'ㅗㅐ',
    ㅚ: 'ㅗㅣ',
    ㅝ: 'ㅜㅓ',
    ㅞ: 'ㅜㅔ',
    ㅟ: 'ㅜㅣ',
    ㅢ: 'ㅡㅣ',
  };

  const initialJamos = [
    'ㄱ',
    'ㄲ',
    'ㄴ',
    'ㄷ',
    'ㄸ',
    'ㄹ',
    'ㅁ',
    'ㅂ',
    'ㅃ',
    'ㅅ',
    'ㅆ',
    'ㅇ',
    'ㅈ',
    'ㅉ',
    'ㅊ',
    'ㅋ',
    'ㅌ',
    'ㅍ',
    'ㅎ',
  ];
  const medialJamos = [
    'ㅏ',
    'ㅐ',
    'ㅑ',
    'ㅒ',
    'ㅓ',
    'ㅔ',
    'ㅕ',
    'ㅖ',
    'ㅗ',
    'ㅘ',
    'ㅙ',
    'ㅚ',
    'ㅛ',
    'ㅜ',
    'ㅝ',
    'ㅞ',
    'ㅟ',
    'ㅠ',
    'ㅡ',
    'ㅢ',
    'ㅣ',
  ];
  const finalJamos = [
    '',
    'ㄱ',
    'ㄲ',
    'ㄳ',
    'ㄴ',
    'ㄵ',
    'ㄶ',
    'ㄷ',
    'ㄹ',
    'ㄺ',
    'ㄻ',
    'ㄼ',
    'ㄽ',
    'ㄾ',
    'ㄿ',
    'ㅀ',
    'ㅁ',
    'ㅂ',
    'ㅄ',
    'ㅅ',
    'ㅆ',
    'ㅇ',
    'ㅈ',
    'ㅊ',
    'ㅋ',
    'ㅌ',
    'ㅍ',
    'ㅎ',
  ];

  for (let i = 0; i < word.length; i++) {
    const code = word.codePointAt(i)!;
    const originalIndex = i;

    if (code > 0xffff) {
      i++;
    }

    if (code >= 0x41 && code <= 0x5a) {
      result += String.fromCharCode(code + 0x20);
      mapping.push(originalIndex);
    } else if (
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39)
    ) {
      // 'a' to 'z' or '0' to '9'
      result += String.fromCharCode(code);
      mapping.push(originalIndex);
    } else if (code >= 0xac00 && code <= 0xd7a3) {
      const codeOffset = code - 0xac00;
      const initial = Math.floor(codeOffset / (21 * 28));
      const medial = Math.floor((codeOffset % (21 * 28)) / 28);
      const final = codeOffset % 28;

      result += initialJamos[initial];
      mapping.push(originalIndex);

      const medialJamo = medialJamos[medial];
      if (complexMedials[medialJamo]) {
        for (const char of complexMedials[medialJamo]) {
          result += char;
          mapping.push(originalIndex);
        }
      } else {
        result += medialJamo;
        mapping.push(originalIndex);
      }

      if (final !== 0) {
        result += finalJamos[final];
        mapping.push(originalIndex);
      }
    } else {
      result += String.fromCodePoint(code);
      mapping.push(originalIndex);
    }
  }

  return [result, mapping];
}

export function calcGapMatch(small: string, large: string) {
  const [smallN] = normalize(small);
  const [largeN, largeMapping] = normalize(large);
  const m = smallN.length;
  const n = largeN.length;
  const dp = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => [inf, inf]),
  );
  const backtrack: any = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => [null, null]),
  );

  dp[0][0][0] = 0;

  for (let i = 0; i <= m; i++) {
    for (let j = 0; j < n; j++) {
      const [gapCount, matchCount] = dp[i][j];
      if (i < m && smallN[i] === largeN[j]) {
        if (gapCount + 1 < dp[i + 1][j + 1][1]) {
          dp[i + 1][j + 1][1] = gapCount + 1;
          backtrack[i + 1][j + 1][1] = [i, j, 0];
        }
        if (matchCount < dp[i + 1][j + 1][1]) {
          dp[i + 1][j + 1][1] = matchCount;
          backtrack[i + 1][j + 1][1] = [i, j, 1];
        }
      }
      if (gapCount < dp[i][j + 1][0]) {
        dp[i][j + 1][0] = gapCount;
        backtrack[i][j + 1][0] = [i, j, 0];
      }
      if (matchCount < dp[i][j + 1][0]) {
        dp[i][j + 1][0] = matchCount;
        backtrack[i][j + 1][0] = [i, j, 1];
      }
    }
  }

  const result = Math.min(dp[m][n][0], dp[m][n][1]);
  if (result === inf) {
    return { result, path: [] };
  }
  const path = [];
  let i = m;
  let j = n;
  let k = dp[m][n][0] < dp[m][n][1] ? 0 : 1;

  while (i !== 0 || j !== 0) {
    const [prevI, prevJ, prevK] = backtrack[i][j][k];
    if (i - 1 === prevI && j - 1 === prevJ) {
      path.push(largeMapping[j - 1]);
    }
    i = prevI;
    j = prevJ;
    k = prevK;
  }

  path.reverse();
  return { result, path };
}
