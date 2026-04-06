import { Sidebar } from '@/components/shared/sidebar'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 bg-gray-50 overflow-auto">
        <div className="p-6">{children}</div>
      </main>
    </div>
  )
}
