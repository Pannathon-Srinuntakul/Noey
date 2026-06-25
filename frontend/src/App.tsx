import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'

const LoginPage = lazy(() => import('./pages/LoginPage'))
const IslandPage = lazy(() => import('./pages/IslandPage'))
const CatalogPage = lazy(() => import('./pages/CatalogPage'))
const MarketPage = lazy(() => import('./pages/MarketPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const ImportPage = lazy(() => import('./pages/ImportPage'))
const RevenuePage = lazy(() => import('./pages/RevenuePage'))
const TablePage = lazy(() => import('./pages/TablePage'))
const ManageFieldsPage = lazy(() => import('./pages/ManageFieldsPage'))
const CreateTablePage = lazy(() => import('./pages/CreateTablePage'))
const VideoPage = lazy(() => import('./pages/VideoPage'))

export default function App() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <Suspense fallback={null}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<RequireAuth><IslandPage /></RequireAuth>} />
          <Route path="/catalog" element={<RequireAuth><CatalogPage /></RequireAuth>} />
          <Route path="/market" element={<RequireAuth><MarketPage /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
          <Route path="/import" element={<RequireAuth><ImportPage /></RequireAuth>} />
          <Route path="/revenue" element={<RequireAuth><RevenuePage /></RequireAuth>} />
          <Route path="/tables" element={<RequireAuth><TablePage /></RequireAuth>} />
          <Route path="/tables/create" element={<RequireAuth><CreateTablePage /></RequireAuth>} />
          <Route path="/tables/edit/:id" element={<RequireAuth><ManageFieldsPage /></RequireAuth>} />
          <Route path="/tables/:id" element={<RequireAuth><TablePage /></RequireAuth>} />
          <Route path="/videos" element={<RequireAuth><VideoPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </div>
  )
}
