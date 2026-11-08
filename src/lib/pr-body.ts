/**
 * PR 正文预处理：剥掉模板里的 HTML 注释。只做这一件事 —— 不裁空白、不折叠空行、
 * 不改缩进，换行与缩进都是作者写的。
 */

/** 已闭合的注释跨行也要吃掉；未闭合的 `<!--` 从该处一直吃到结尾。 */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

export function stripHtmlComments(text: string): string {
  return text.replace(HTML_COMMENT, "");
}
