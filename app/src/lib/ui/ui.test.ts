import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRawSnippet, tick } from 'svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { setLanguage, lang } from '$lib/i18n';
import { get } from 'svelte/store';
import Icon from './Icon.svelte';
import Button from './Button.svelte';
import Badge from './Badge.svelte';
import Card from './Card.svelte';
import Callout from './Callout.svelte';
import Blob from './Blob.svelte';
import ProgressBar from './ProgressBar.svelte';
import Fingerprint from './Fingerprint.svelte';
import Switch from './Switch.svelte';
import Segmented from './Segmented.svelte';
import Dialog from './Dialog.svelte';
import Stepper from './Stepper.svelte';
import AppBar from './AppBar.svelte';
import ActionBar from './ActionBar.svelte';
import AppFooter from './AppFooter.svelte';
import LanguageSelect from './LanguageSelect.svelte';
import DropZone from './DropZone.svelte';
import IconSprite from './IconSprite.svelte';

const txt = (s: string) => createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));
const btn = (s: string) => createRawSnippet(() => ({ render: () => `<button>${s}</button>` }));
beforeEach(() => { setLanguage('en'); localStorage.clear(); });

describe('primitives', () => {
  test('icon and sprite', () => {
    const { container } = render(Icon, { name: 'key', size: 30, class: 'x' });
    expect(container.querySelector('use')!.getAttribute('href')).toBe('#i-key');
    render(IconSprite);
  });
  test('button variants', async () => {
    const onclick = vi.fn();
    const { rerender } = render(Button, { children: txt('Go'), icon: 'patch', onclick, variant: 'primary', size: 'sm' });
    await fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onclick).toHaveBeenCalled();
    await rerender({ children: txt('Go'), loading: true, size: 'lg' });
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    await rerender({ children: txt('Go'), iconOnly: true, icon: 'x', current: true });
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('aria-current', 'page');
  });
  test('button as link, external and internal', async () => {
    const { rerender } = render(Button, { children: txt('L'), href: '/a', external: true, current: true });
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page');
    await rerender({ children: txt('L'), href: '/a', external: false, current: false });
    expect(screen.getByRole('link')).not.toHaveAttribute('target');
  });
  test('badge, card, callout, blob', async () => {
    const b = render(Badge, { children: txt('B'), icon: 'check', tone: 'ok' });
    expect(b.container.querySelector('use')).toBeTruthy();
    b.unmount();
    const b2 = render(Badge, { children: txt('B'), dot: true });
    expect(b2.container.querySelector('.dot')).toBeTruthy();
    b2.unmount();
    const c = render(Card, { children: txt('C'), tag: 'section', selected: true, muted: true, class: 'k' });
    expect(c.container.querySelector('section.card.selected.k')).toBeTruthy();
    c.unmount();
    const a = render(Callout, { tone: 'warn', title: 'T', children: txt('body'), actions: txt('act'), role: 'alert' });
    expect(screen.getByRole('alert')).toHaveTextContent(/T\s*body\s*act/);
    a.unmount();
    const a2 = render(Callout, { icon: 'key' });
    expect(a2.container.querySelector('use')!.getAttribute('href')).toBe('#i-key');
    a2.unmount();
    const bl = render(Blob, { icon: 'alert', tone: 'bad', size: 50 });
    expect(bl.container.querySelector('.blob')).toHaveStyle({ width: '50px' });
  });
  test('progress bar determinate and indeterminate', async () => {
    const { rerender, container } = render(ProgressBar, { value: 40, label: 'p', valuetext: '40 %', striped: true });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(container.querySelector('.fill')).toHaveStyle({ width: '40%' });
    await rerender({ value: null, label: 'p' });
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(container.querySelector('.ind')).toBeTruthy();
  });
  test('fingerprint', () => {
    render(Fingerprint, { pairs: ['AA', 'BB'], labelledby: 'x' });
    expect(screen.getByRole('group')).toHaveTextContent('AABB');
  });
  test('switch with and without hint', async () => {
    const { rerender } = render(Switch, { id: 's', label: 'L', hint: 'H', checked: false });
    const sw = screen.getByRole('switch', { name: 'L' });
    await fireEvent.click(sw);
    expect(sw).toBeChecked();
    expect(sw).toHaveAccessibleDescription('H');
    await rerender({ id: 's', label: 'L', hint: undefined, checked: true });
    expect(screen.getByRole('switch')).not.toHaveAttribute('aria-describedby');
  });
  test('segmented click and arrow keys wrap', async () => {
    render(Segmented, { options: [{ value: 'a', label: 'A', icon: 'sun' }, { value: 'b', label: 'B' }], value: 'a', label: 'seg' });
    const [a, b] = screen.getAllByRole('radio');
    expect(a).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(b!);
    expect(b).toHaveAttribute('aria-checked', 'true');
    await fireEvent.keyDown(b!, { key: 'ArrowRight' });
    expect(a).toHaveAttribute('aria-checked', 'true');
    await fireEvent.keyDown(a!, { key: 'ArrowLeft' });
    expect(b).toHaveAttribute('aria-checked', 'true');
    await fireEvent.keyDown(b!, { key: 'ArrowDown' });
    await fireEvent.keyDown(a!, { key: 'ArrowUp' });
    await fireEvent.keyDown(a!, { key: 'x' });
    expect(b).toHaveAttribute('aria-checked', 'true');
  });
});

describe('dialog', () => {
  const body = createRawSnippet(() => ({ render: () => '<div><h2 id="t">T</h2><button id="first">one</button><button id="last">two</button></div>' }));
  test('focuses first control, traps Tab, Esc closes, focus returns', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onclose = vi.fn();
    const { unmount } = render(Dialog, { labelledby: 't', onclose, children: body });
    await tick();
    const dlg = screen.getByRole('dialog');
    expect(document.activeElement!.id).toBe('first');
    await fireEvent.keyDown(dlg, { key: 'Tab', shiftKey: true });
    expect(document.activeElement!.id).toBe('last');
    await fireEvent.keyDown(dlg, { key: 'Tab' });
    expect(document.activeElement!.id).toBe('first');
    await fireEvent.keyDown(dlg, { key: 'Tab' }); // middle: browser default
    await fireEvent.keyDown(dlg, { key: 'a' });
    await fireEvent.keyDown(dlg, { key: 'Escape' });
    expect(onclose).toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  test('without onclose Esc is ignored; data-autofocus wins; empty dialog traps', async () => {
    const withAuto = createRawSnippet(() => ({ render: () => '<div><button>a</button><button data-autofocus id="auto">b</button></div>' }));
    const r = render(Dialog, { labelledby: 't', children: withAuto });
    await tick();
    expect(document.activeElement!.id).toBe('auto');
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    r.unmount();
    const empty = createRawSnippet(() => ({ render: () => '<p>nothing</p>' }));
    render(Dialog, { labelledby: 't', describedby: 'd', children: empty });
    await tick();
    const dlg = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dlg);
    await fireEvent.keyDown(dlg, { key: 'Tab' });
    expect(document.activeElement).toBe(dlg);
  });
  test('shift-tab from the dialog root wraps to the last control', async () => {
    render(Dialog, { labelledby: 't', children: body });
    await tick();
    const dlg = screen.getByRole('dialog');
    dlg.focus();
    await fireEvent.keyDown(dlg, { key: 'Tab', shiftKey: true });
    expect(document.activeElement!.id).toBe('last');
  });
});

describe('navigation chrome', () => {
  test('stepper states', () => {
    const { rerender, container } = render(Stepper, { current: 2 });
    expect(container.querySelectorAll('.done')).toHaveLength(1);
    expect(screen.getByText('Review').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Save')).toBeInTheDocument();
    rerender({ current: 3, failed: true, install: true });
    return tick().then(() => {
      expect(container.querySelector('.fail')).toBeTruthy();
      expect(screen.getByText('Install')).toBeInTheDocument();
    });
  });
  test('app bar: stepper only on patch view, toggles views, locked hides tools', async () => {
    const onnavigate = vi.fn();
    const { rerender } = render(AppBar, { view: 'patch', step: 1, onnavigate });
    expect(screen.getByRole('navigation', { name: 'Patch steps' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Keys' }));
    expect(onnavigate).toHaveBeenLastCalledWith('keys');
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onnavigate).toHaveBeenLastCalledWith('settings');
    await rerender({ view: 'keys', step: 1, onnavigate });
    expect(screen.queryByRole('navigation', { name: 'Patch steps' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Keys' }));
    expect(onnavigate).toHaveBeenLastCalledWith('patch');
    await rerender({ view: 'settings', step: 1, onnavigate });
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onnavigate).toHaveBeenLastCalledWith('patch');
    await rerender({ view: 'patch', step: 3, locked: true, onnavigate });
    expect(screen.queryByRole('button', { name: 'Keys' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('locked');
  });
  test('action bar renders both sides and works with only one', () => {
    render(ActionBar, { start: btn('s'), end: btn('e') });
    expect(screen.getByText('s')).toBeInTheDocument();
    expect(screen.getByText('e')).toBeInTheDocument();
    render(ActionBar, {});
  });
  test('footer: web vs native, with and without key', () => {
    const { rerender } = render(AppFooter, { platformKind: 'web', activeKey: null });
    expect(screen.getByText('Runs in your browser')).toBeInTheDocument();
    expect(screen.getByText(/created when you patch/)).toBeInTheDocument();
    expect(screen.getByTestId('legal-notice')).toHaveTextContent('Not affiliated');
    rerender({ platformKind: 'tauri-desktop', activeKey: { id: 'AA:BB:CC', name: '', addedAt: 0, fingerprint: 'AA:BB:CC', pairs: [], active: true } });
    return tick().then(() => {
      expect(screen.getByText('Works offline')).toBeInTheDocument();
      expect(screen.getByText(/My key \(AA:BB:CC\)/)).toBeInTheDocument();
    });
  });
  test('language select switches language', async () => {
    const { rerender } = render(LanguageSelect, { id: 'l', iconLeft: true });
    await fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'tr' } });
    expect(get(lang)).toBe('tr');
    await rerender({ id: 'l' });
  });
});

describe('DropZone', () => {
  const base = { onbrowse: vi.fn(), oncancel: vi.fn(), onfile: vi.fn() };
  test('idle (droppable and not), browse, drag over/leave, drop', async () => {
    const onfile = vi.fn(), onbrowse = vi.fn();
    const { container, rerender } = render(DropZone, { ...base, mode: 'idle', droppable: true, onfile, onbrowse });
    expect(screen.getByRole('heading')).toHaveTextContent('Drop the game APK here');
    await fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    expect(onbrowse).toHaveBeenCalled();
    const zone = container.querySelector('.drop')!;
    await fireEvent.dragOver(zone);
    expect(screen.getByText('Release to open this file')).toBeInTheDocument();
    await fireEvent.dragLeave(zone);
    expect(screen.queryByText('Release to open this file')).toBeNull();
    await fireEvent.dragOver(zone);
    const f = new File([new Uint8Array(1)], 'a.apk');
    await fireEvent.drop(zone, { dataTransfer: { files: [f] } });
    expect(onfile).toHaveBeenCalledWith(f);
    await fireEvent.drop(zone, { dataTransfer: { files: [] } });
    await fireEvent.drop(zone);
    expect(onfile).toHaveBeenCalledTimes(1);
    await rerender({ ...base, mode: 'idle', droppable: false });
    expect(screen.getByRole('heading')).toHaveTextContent('Choose the game APK');
    await fireEvent.dragOver(zone);
    expect(screen.queryByText('Release to open this file')).toBeNull();
  });
  test('reading shows file info, cancel; drops ignored while reading', async () => {
    const oncancel = vi.fn(), onfile = vi.fn();
    const { container } = render(DropZone, { ...base, oncancel, onfile, mode: 'reading', droppable: true, file: { name: 'x.apk', size: 2_000_000 } });
    expect(screen.getByText('x.apk')).toBeInTheDocument();
    expect(screen.getByText('2 MB')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reading game info');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel reading' }));
    expect(oncancel).toHaveBeenCalled();
    await fireEvent.dragOver(container.querySelector('.drop')!);
    await fireEvent.drop(container.querySelector('.drop')!, { dataTransfer: { files: [new File([], 'a')] } });
    expect(onfile).not.toHaveBeenCalled();
  });
  test('error with and without help link, and over while in error', async () => {
    const onbrowse = vi.fn();
    const { rerender, container } = render(DropZone, { ...base, onbrowse, mode: 'error', error: { title: 'Bad', body: 'why', helpLabel: 'Help' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/Bad\s*why/);
    expect(screen.getByRole('link', { name: 'Help' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Choose another file' }));
    expect(onbrowse).toHaveBeenCalled();
    await rerender({ ...base, mode: 'error', error: { title: 'Bad', body: 'why' }, droppable: true });
    expect(screen.queryByRole('link', { name: 'Help' })).toBeNull();
    await fireEvent.dragOver(container.querySelector('.drop')!);
    expect(screen.getByText('Release to open this file')).toBeInTheDocument();
  });
  test('error mode without an error object falls back to idle content', () => {
    render(DropZone, { ...base, mode: 'error', error: null });
    expect(screen.getByRole('button', { name: 'Browse files' })).toBeInTheDocument();
  });
});
