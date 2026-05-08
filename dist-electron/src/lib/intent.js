export function parseVoiceCommand(raw) {
    const text = raw.trim().toLowerCase();
    if (!text) {
        return null;
    }
    if (/(确认执行|确定执行|confirm)/.test(text)) {
        return { kind: 'confirm_pending', confirmed: true };
    }
    if (/(点击这里|click here|点这里)/.test(text)) {
        return { kind: 'click_here' };
    }
    if (/(切到这个tab|切换tab|switch tab|next tab)/.test(text)) {
        return { kind: 'switch_tab' };
    }
    const typeMatch = text.match(/(?:输入|type)\s+(.+)/);
    if (typeMatch?.[1]) {
        return { kind: 'type_text', text: typeMatch[1].trim() };
    }
    const openMatch = text.match(/(?:打开|open)\s+(.+)/);
    if (openMatch?.[1]) {
        return { kind: 'open_app', appName: openMatch[1].trim() };
    }
    return null;
}
//# sourceMappingURL=intent.js.map