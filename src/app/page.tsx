import { redirect } from 'next/navigation';
import { DEFAULT_STRATEGY } from '@/lib/strategies';

export default function Page() {
  redirect(`/${DEFAULT_STRATEGY}`);
}
