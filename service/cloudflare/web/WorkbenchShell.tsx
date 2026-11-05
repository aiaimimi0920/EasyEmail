import { Button, ButtonLink, IconButton, NavigationItem } from '@neuro/ui';
import { useState, type ReactNode } from 'react';
import { RailIcon } from '../../../apps/desktop/src/components/AppIcons';
import { BrandIcon } from './BrandIcon';
import type { User } from './api';

const sections = [
  { title: '邮件', items: [
    { id: 'mailboxes', label: '邮箱管理', icon: 'mail' },
    { id: 'inbox', label: '聚合收件箱', icon: 'inbox' },
    { id: 'outgoing', label: '写信与发送记录', icon: 'compose' },
    { id: 'contacts', label: '联系人', icon: 'grid' },
    { id: 'subscriptions', label: '订阅邮件', icon: 'newsletters' },
    { id: 'normal', label: '普通邮箱', icon: 'all-mail' },
  ] },
  { title: 'Agent', items: [
    { id: 'agents', label: 'Agent 服务', icon: 'agent' },
    { id: 'agent-accounts', label: 'Agent 邮箱', icon: 'mail' },
    { id: 'agent-tasks', label: 'Agent 任务', icon: 'queue' },
    { id: 'agent-threads', label: 'Agent 线程', icon: 'drafts' },
  ] },
  { title: '设置', items: [
    { id: 'keys', label: 'API Key', icon: 'setup' },
    { id: 'security', label: '账号安全', icon: 'setup' },
    { id: 'admin', label: '平台管理', icon: 'grid' },
  ] },
] as const;

export function WorkbenchShell({ user, view, onNavigate, onLogout, children }: {
  user: User; view: string; onNavigate: (view: string) => void; onLogout: () => void; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const current = sections.flatMap(section => [...section.items]).find(item => item.id === view);
  return <main className="ee-workbench" data-collapsed={collapsed}>
    <ButtonLink className="skip-link" href="#workspace-content" variant="primary">跳到工作区</ButtonLink>
    <aside className="workbench-rail">
      <div className="workbench-brand"><BrandIcon /><strong>EasyEmail</strong>
        <IconButton className="rail-toggle" label={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)} variant="quiet" compact>{collapsed ? '›' : '‹'}</IconButton></div>
      <nav aria-label="邮件工作台">{sections.map(section => <section className="navigation-group" key={section.title}>
        <h2>{section.title}</h2>
        {section.items.filter(item => item.id !== 'admin' || user.isAdmin).map(item => <NavigationItem key={item.id} className="navigation-item" aria-label={item.label} title={item.label} active={view === item.id} aria-pressed={view === item.id} onClick={() => onNavigate(item.id)}><RailIcon kind={item.icon} /><span>{item.label}</span></NavigationItem>)}
      </section>)}</nav>
      <div className="workbench-account"><span className="account-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="account-name">{user.username}</span><Button onClick={onLogout} variant="quiet" wrap>退出登录</Button></div>
    </aside>
    <section className="workbench-board">
      <header className="workbench-heading"><div>
        <h1 aria-label={`${current?.label ?? 'EasyEmail'}工作区`}>{current?.label ?? 'EasyEmail'}</h1></div><span className="workspace-host">{window.location.host}</span></header>
      <div id="workspace-content" className="workbench-content" tabIndex={-1}>{children}</div>
    </section>
  </main>;
}
