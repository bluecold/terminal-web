import { useEffect, useState } from 'react';
import { fetchEarningsCalendar } from '../services/api';
import type { EarningsEvent } from '../utils/marketEvents';

const REFRESH_MS = 3_600_000;

export function useEarningsCalendar(symbols: string[]): Record<string, EarningsEvent> {
  const [events, setEvents] = useState<Record<string, EarningsEvent>>({});
  const symbolsKey = [...symbols].sort().join(',');

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      const data = await fetchEarningsCalendar(symbolsKey ? symbolsKey.split(',') : []);
      if (isMounted) setEvents(data);
    };
    load();
    const intervalId = setInterval(load, REFRESH_MS);
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [symbolsKey]);

  return events;
}
