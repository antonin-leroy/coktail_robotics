import { useQuery } from '@tanstack/react-query'
import { Link, useMatchRoute } from '@tanstack/react-router'
import {
  Database,
  FlaskConical,
  Plus,
  Sparkles,
} from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { api } from '@/lib/api'

const nav = [
  { label: 'Data', items: [{ to: '/datasets', label: 'Datasets', icon: Database }] },
  {
    label: 'Training',
    items: [
      { to: '/training/new', label: 'New run', icon: Plus, exact: true },
      { to: '/training', label: 'Runs', icon: FlaskConical, exact: true, live: true },
    ],
  },
  { label: 'Skills', items: [{ to: '/skills', label: 'Skills', icon: Sparkles }] },
] as const

export function AppSidebar() {
  const matchRoute = useMatchRoute()
  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs })
  const active = runs.data?.filter((r) => ['queued', 'submitting', 'running'].includes(r.status)).length ?? 0

  return (
    <Sidebar>
      <SidebarHeader className="px-4 pt-5 pb-3">
        <Link to="/datasets" className="flex items-center">
          <div className="leading-tight">
            <div className="text-sm font-semibold">Cocktail Lab</div>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {nav.map((group, i) => (
          <SidebarGroup key={i}>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: item.to, fuzzy: !('exact' in item && item.exact) })}
                    className="h-9 text-[15px]"
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                  {'live' in item && active > 0 && (
                    <SidebarMenuBadge>
                      <span className="mr-1 size-1.5 animate-pulse rounded-full bg-chart-1" />
                      {active}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

    </Sidebar>
  )
}
