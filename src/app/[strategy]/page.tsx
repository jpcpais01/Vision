import { notFound } from 'next/navigation';
import { isStrategyId } from '@/lib/strategies';
import { StrategyDashboard } from '@/components/StrategyDashboard';

export const dynamic = 'force-dynamic';

export default function StrategyPage({ params }: { params: { strategy: string } }) {
  if (!isStrategyId(params.strategy)) notFound();
  return <StrategyDashboard strategyId={params.strategy} />;
}
