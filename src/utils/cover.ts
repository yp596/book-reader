/** 由书名派生一个稳定的色相，让没有封面的书各有辨识度（同一本书永远同色） */
export function coverHue(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i += 1) h = (h * 31 + title.charCodeAt(i)) % 360;
  return h;
}
