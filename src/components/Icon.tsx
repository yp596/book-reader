import type { CSSProperties, ReactNode } from 'react';

/**
 * 全站统一图标组件。
 * 统一 24 视图、线性描边、圆角端点，随字号继承 currentColor。
 * 图标一律走这里，避免再出现 emoji 在各平台字形不一致的问题。
 */
export type IconName =
  | 'library' | 'globe' | 'chart' | 'notebook' | 'note' | 'sparkles' | 'scale' | 'ruler'
  | 'cpu' | 'settings' | 'help' | 'plus' | 'search' | 'x' | 'check' | 'star' | 'star-fill'
  | 'trash' | 'edit' | 'refresh' | 'upload' | 'download' | 'folder' | 'file' | 'chevron-down'
  | 'chevron-left' | 'chevron-right' | 'arrow-left' | 'arrow-right' | 'book' | 'book-open'
  | 'bookmark' | 'bookmark-fill' | 'network' | 'lock' | 'unlock' | 'pin' | 'eye' | 'eye-off'
  | 'copy' | 'printer' | 'image' | 'volume' | 'stop' | 'list' | 'grid' | 'menu' | 'filter'
  | 'alert' | 'info' | 'clock' | 'target' | 'tag' | 'sliders' | 'maximize' | 'rows' | 'columns'
  | 'undo' | 'redo' | 'phone' | 'scan' | 'wand' | 'moon' | 'sun' | 'palette' | 'zoom-in'
  | 'zoom-out' | 'fit-width' | 'fit-height' | 'fit-page' | 'package' | 'moon-zzz' | 'lightning' | 'phone-signal'
  | 'cloud-up' | 'cloud-down' | 'sort' | 'eraser' | 'side-by-side' | 'code' | 'external-link'
  | 'play' | 'pause' | 'rotate-cw' | 'type' | 'map-pin' | 'battery';

/** 需要实心渲染的图标（描边画不出来或观感更差） */
const FILLED = new Set<IconName>(['star-fill', 'bookmark-fill', 'lightning', 'package', 'phone-signal', 'play']);

const PATHS: Record<IconName, ReactNode> = {
  library: (<><path d="M16 5v15" /><path d="M11 5v15" /><path d="M6 7v13" /><path d="M2 4v16" /></>),
  globe: (<><circle cx="12" cy="12" r="9.5" /><path d="M12 2.5c2.5 2.6 4 6 4 9.5s-1.5 6.9-4 9.5c-2.5-2.6-4-6-4-9.5s1.5-6.9 4-9.5Z" /><path d="M2.5 12h19" /></>),
  chart: (<><path d="M6 20v-6" /><path d="M12 20V8" /><path d="M18 20v-9" /><path d="M3 20h18" /></>),
  notebook: (<><path d="M4 5a2 2 0 0 1 2-2h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2Z" /><path d="M8 3v18" /><path d="M12 8h4" /><path d="M12 12h4" /></>),
  note: (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h4" /></>),
  sparkles: (<><path d="M11 3.5 12.4 8a2 2 0 0 0 1.2 1.2L18 10.5l-4.4 1.4A2 2 0 0 0 12.4 13L11 17.5 9.6 13A2 2 0 0 0 8.4 11.8L4 10.5l4.4-1.4A2 2 0 0 0 9.6 8Z" /><path d="M18.5 3v3.5" /><path d="M16.75 4.75h3.5" /><path d="M18 17.5v3" /><path d="M16.5 19h3" /></>),
  scale: (<><path d="M12 3v18" /><path d="M5 7h14" /><path d="M7 7 4 14h6Z" /><path d="M17 7l-3 7h6Z" /><path d="M8 21h8" /></>),
  ruler: (<><path d="M15.6 2.6 21.4 8.4a2 2 0 0 1 0 2.8l-10.2 10.2a2 2 0 0 1-2.8 0L2.6 15.6a2 2 0 0 1 0-2.8L12.8 2.6a2 2 0 0 1 2.8 0Z" /><path d="m12.5 5.5 3 3" /><path d="m9.5 8.5 3 3" /><path d="m6.5 11.5 3 3" /></>),
  cpu: (<><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 2v3" /><path d="M15 2v3" /><path d="M9 19v3" /><path d="M15 19v3" /><path d="M2 9h3" /><path d="M2 15h3" /><path d="M19 9h3" /><path d="M19 15h3" /></>),
  settings: (<><circle cx="12" cy="12" r="3" /><path d="M12 2.5 13.4 5a7.5 7.5 0 0 1 2.2 1.3l2.7-.6 1.5 2.6-1.9 2a7.5 7.5 0 0 1 0 2.5l1.9 2-1.5 2.6-2.7-.6A7.5 7.5 0 0 1 13.4 19L12 21.5 10.6 19a7.5 7.5 0 0 1-2.2-1.3l-2.7.6-1.5-2.6 1.9-2a7.5 7.5 0 0 1 0-2.5l-1.9-2 1.5-2.6 2.7.6A7.5 7.5 0 0 1 10.6 5Z" /></>),
  help: (<><circle cx="12" cy="12" r="9.5" /><path d="M9.4 9.4a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.7-2.6 2.7" /><path d="M12 17h.01" /></>),
  plus: (<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  search: (<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.9-3.9" /></>),
  x: (<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>),
  check: (<><path d="m20 6-11 11-5-5" /></>),
  star: (<><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z" /></>),
  'star-fill': (<><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z" /></>),
  trash: (<><path d="M4 6.5h16" /><path d="M9 6.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" /><path d="M6 6.5 7 19a2 2 0 0 0 2 1.8h6a2 2 0 0 0 2-1.8l1-12.5" /><path d="M10 10.5v6" /><path d="M14 10.5v6" /></>),
  edit: (<><path d="M11 19.5H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.5a2 2 0 0 1 2 2v6" /><path d="M17.8 13.3a2.1 2.1 0 0 1 3 3L15 22l-4 1 1-4Z" /></>),
  refresh: (<><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" /><path d="M20.5 4.5V10H15" /></>),
  upload: (<><path d="M20.5 15.5V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3.5" /><path d="m8 8 4-4 4 4" /><path d="M12 4v12" /></>),
  download: (<><path d="M20.5 15.5V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3.5" /><path d="m8 12 4 4 4-4" /><path d="M12 16V4" /></>),
  folder: (<><path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l1 1.4a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>),
  file: (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></>),
  'chevron-down': (<><path d="m6 9.5 6 6 6-6" /></>),
  'chevron-left': (<><path d="m14.5 6-6 6 6 6" /></>),
  'chevron-right': (<><path d="m9.5 6 6 6-6 6" /></>),
  'arrow-left': (<><path d="M20 12H4" /><path d="m10 6-6 6 6 6" /></>),
  'arrow-right': (<><path d="M4 12h16" /><path d="m14 6 6 6-6 6" /></>),
  book: (<><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v18H7.5A2.5 2.5 0 0 0 5 22.5Z" /><path d="M5 17.5A2.5 2.5 0 0 1 7.5 15H19" /></>),
  'book-open': (<><path d="M12 6.5C10.5 5 8.5 4.3 6 4.3c-1 0-1.9.1-2.7.4v13.6c.8-.3 1.7-.4 2.7-.4 2.5 0 4.5.7 6 2.2 1.5-1.5 3.5-2.2 6-2.2 1 0 1.9.1 2.7.4V4.7A9.6 9.6 0 0 0 18 4.3c-2.5 0-4.5.7-6 2.2Z" /><path d="M12 6.5v13.6" /></>),
  bookmark: (<><path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.2L5.5 20.5v-16a1 1 0 0 1 1-1Z" /></>),
  'bookmark-fill': (<><path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.2L5.5 20.5v-16a1 1 0 0 1 1-1Z" /></>),
  network: (<><rect x="9" y="2.5" width="6" height="5" rx="1.2" /><rect x="2.5" y="16.5" width="6" height="5" rx="1.2" /><rect x="15.5" y="16.5" width="6" height="5" rx="1.2" /><path d="M12 7.5v4" /><path d="M5.5 16.5v-3a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3" /></>),
  lock: (<><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>),
  unlock: (<><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 7.5-2" /></>),
  pin: (<><path d="M12 21v-6" /><path d="M8.5 3h7l-1 5 2.5 3v2H7v-2l2.5-3Z" /></>),
  eye: (<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>),
  'eye-off': (<><path d="M4 4l16 16" /><path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.9" /><path d="M6.3 7.8A17.5 17.5 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 3.5-.7" /><path d="M9.9 10.1a3 3 0 0 0 4.1 4.2" /></>),
  copy: (<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>),
  printer: (<><path d="M7 8V3.5h10V8" /><rect x="3.5" y="8" width="17" height="8" rx="2" /><path d="M7 14h10v6.5H7Z" /></>),
  image: (<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m5 17 4.5-4.5a1.5 1.5 0 0 1 2.1 0L17 18" /><path d="m14.5 15 1.6-1.6a1.5 1.5 0 0 1 2.1 0L20 15" /></>),
  volume: (<><path d="M11 5 6.5 9H3v6h3.5L11 19Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>),
  stop: (<><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" /></>),
  list: (<><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3.5 6h.01" /><path d="M3.5 12h.01" /><path d="M3.5 18h.01" /></>),
  grid: (<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>),
  menu: (<><path d="M3.5 7h17" /><path d="M3.5 12h17" /><path d="M3.5 17h17" /></>),
  filter: (<><path d="M3.5 5.5h17l-6.5 7.5v5l-4 2v-7Z" /></>),
  alert: (<><path d="M10.3 3.9 2.6 17.2a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4" /><path d="M12 17h.01" /></>),
  info: (<><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5" /><path d="M12 7.8h.01" /></>),
  clock: (<><circle cx="12" cy="12" r="9.5" /><path d="M12 7v5.3l3.4 2" /></>),
  target: (<><circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="12" r="5.5" /><circle cx="12" cy="12" r="1.6" /></>),
  tag: (<><path d="M11.6 2.6A2 2 0 0 0 10.2 2H4a2 2 0 0 0-2 2v6.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z" /><circle cx="7" cy="7" r="1.4" /></>),
  sliders: (<><path d="M4 7h9" /><path d="M17 7h3" /><path d="M4 17h4" /><path d="M12 17h8" /><circle cx="15" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>),
  maximize: (<><path d="M8.5 3.5h-5v5" /><path d="M15.5 3.5h5v5" /><path d="M15.5 20.5h5v-5" /><path d="M8.5 20.5h-5v-5" /></>),
  rows: (<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 12h17" /></>),
  columns: (<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M12 4.5v15" /></>),
  'side-by-side': (<><rect x="3.5" y="4.5" width="7.5" height="15" rx="1.8" /><rect x="13" y="4.5" width="7.5" height="15" rx="1.8" /></>),
  undo: (<><path d="M4 8h10a5.5 5.5 0 0 1 0 11h-5" /><path d="m7.5 4.5-3.5 3.5 3.5 3.5" /></>),
  redo: (<><path d="M20 8H10a5.5 5.5 0 0 0 0 11h5" /><path d="m16.5 4.5 3.5 3.5-3.5 3.5" /></>),
  phone: (<><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 5.5h3" /></>),
  scan: (<><path d="M3.5 8.5v-3a2 2 0 0 1 2-2h3" /><path d="M15.5 3.5h3a2 2 0 0 1 2 2v3" /><path d="M20.5 15.5v3a2 2 0 0 1-2 2h-3" /><path d="M8.5 20.5h-3a2 2 0 0 1-2-2v-3" /><path d="M8 12h8" /></>),
  wand: (<><path d="m4 20 9.5-9.5" /><path d="M14.5 3.5 16 6l2.5 1.5L16 9l-1.5 2.5L13 9l-2.5-1.5L13 6Z" /><path d="M19.5 14v3" /><path d="M18 15.5h3" /></>),
  moon: (<><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></>),
  'moon-zzz': (<><path d="M19 13.5A7.5 7.5 0 0 1 10.5 5 7.5 7.5 0 1 0 19 13.5Z" /><path d="M15 3h4l-4 4h4" /></>),
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2" /><path d="M12 19.3v2.2" /><path d="M21.5 12h-2.2" /><path d="M4.7 12H2.5" /><path d="m18.7 5.3-1.6 1.6" /><path d="m6.9 17.1-1.6 1.6" /><path d="m18.7 18.7-1.6-1.6" /><path d="m6.9 6.9-1.6-1.6" /></>),
  palette: (<><path d="M12 21.5a9.5 9.5 0 1 1 9.5-9.5c0 2.5-2 3.5-3.8 3.5h-1.4a2.3 2.3 0 0 0-1.6 3.9c.5.5.8 1.1.3 1.6a2 2 0 0 1-1.5.5Z" /><circle cx="7.5" cy="12" r="1.3" /><circle cx="9.8" cy="8" r="1.3" /><circle cx="14.2" cy="8" r="1.3" /></>),
  'zoom-in': (<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.9-3.9" /><path d="M11 8.5v5" /><path d="M8.5 11h5" /></>),
  'zoom-out': (<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.9-3.9" /><path d="M8.5 11h5" /></>),
  'fit-width': (<><path d="M3.5 12h17" /><path d="m7 8.5-3.5 3.5L7 15.5" /><path d="m17 8.5 3.5 3.5L17 15.5" /></>),
  'fit-height': (<><path d="M12 3.5v17" /><path d="m8.5 7 3.5-3.5L15.5 7" /><path d="m8.5 17 3.5 3.5L15.5 17" /></>),
  'fit-page': (<><rect x="4" y="3.5" width="16" height="17" rx="2" /><rect x="8.5" y="8" width="7" height="8" rx="1" /></>),
  package: (<><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Z" /><path d="M3.5 7 12 11.5 20.5 7" /><path d="M12 11.5v10" /></>),
  lightning: (<><path d="M13.5 2 4.5 13.5H11l-.5 8.5 9-11.5H13Z" /></>),
  'phone-signal': (<><path d="M8.5 4.5h-3a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3" /><path d="M14 4h6v6" /><path d="m20 4-7 7" /></>),
  'cloud-up': (<><path d="M7 18.5a4.5 4.5 0 0 1-.6-9 5.5 5.5 0 0 1 10.4-1.4A4 4 0 0 1 17.5 18.5" /><path d="m9.5 14 2.5-2.5L14.5 14" /><path d="M12 11.5v6" /></>),
  'cloud-down': (<><path d="M7 18.5a4.5 4.5 0 0 1-.6-9 5.5 5.5 0 0 1 10.4-1.4A4 4 0 0 1 17.5 18.5" /><path d="m9.5 14 2.5 2.5 2.5-2.5" /><path d="M12 17.5v-6" /></>),
  sort: (<><path d="M7 4v16" /><path d="m3.5 16.5 3.5 3.5 3.5-3.5" /><path d="M17 20V4" /><path d="m13.5 7.5 3.5-3.5 3.5 3.5" /></>),
  eraser: (<><path d="m8 20-4-4a2 2 0 0 1 0-2.8l8.7-8.7a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L13 20Z" /><path d="M8 20h12" /><path d="m9.5 9.5 6 6" /></>),
  code: (<><path d="m9 8-4.5 4 4.5 4" /><path d="m15 8 4.5 4-4.5 4" /></>),
  'external-link': (<><path d="M14 4h6v6" /><path d="m20 4-8.5 8.5" /><path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h4.5" /></>),
  play: (<><path d="M7 4.8v14.4a1 1 0 0 0 1.53.85l11.2-7.2a1 1 0 0 0 0-1.7L8.53 3.95A1 1 0 0 0 7 4.8Z" /></>),
  pause: (<><rect x="7" y="4.5" width="3.5" height="15" rx="1.2" /><rect x="13.5" y="4.5" width="3.5" height="15" rx="1.2" /></>),
  'rotate-cw': (<><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" /><path d="M20.5 4v5h-5" /></>),
  type: (<><path d="M5 7V5h14v2" /><path d="M12 5v14" /><path d="M9 19h6" /></>),
  'map-pin': (<><path d="M12 21.5s7-5.8 7-11.2a7 7 0 1 0-14 0c0 5.4 7 11.2 7 11.2Z" /><circle cx="12" cy="10" r="2.6" /></>),
  battery: (<><rect x="2.5" y="7.5" width="16" height="9" rx="2.5" /><path d="M21.5 10.5v3" /><rect x="4.8" y="9.8" width="9.5" height="4.4" rx="1.2" fill="currentColor" stroke="none" /></>),
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  title?: string;
}

export function Icon({ name, size = 18, className, strokeWidth = 1.7, style, title }: IconProps) {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={filled ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}

/** 星级评分：满星 / 空星，替代 ★☆ 文本 */
export function StarRating({ value, size = 13 }: { value: number; size?: number }) {
  const n = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span className="rating-stars" title={`${n} 星`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Icon
          key={i}
          name={i < n ? 'star-fill' : 'star'}
          size={size}
          className={i < n ? 'on' : 'off'}
          strokeWidth={1.4}
        />
      ))}
    </span>
  );
}
