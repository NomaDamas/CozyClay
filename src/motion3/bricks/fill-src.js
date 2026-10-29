// How a fill key is marked: src "fill#<key>.<gap>" (a bare "fill" in older specs). The key thinning pass (thin.js) and the
// patch checks leave fill keys alone: they are not the author's keys.
export const isFillKey = k => typeof k?.src === "string" && /^fill(#|$)/.test(k.src);
