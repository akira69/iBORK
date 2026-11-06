export type RemoteDisplayStatus = {
  lastSeen: number;
  connected: boolean;
  snapshot?: {
    devices: {
      id: string;
      name: string;
      model: string;
      watts: number | null;
      metered: boolean;
      controls: boolean;
      sidebar?: { label: string; image?: string };
    }[];
    details?: Record<
      string,
      {
        pending?: boolean;
        temperature?: number | null;
        fan?: number | null;
        fanMax?: number | null;
        powerState?: string;
        image?: string;
      }
    >;
    day: (number | null)[];
    month: (number | null)[];
    dayKwh: number | null;
    monthKwh: number | null;
    dayHours: number;
    monthHours: number;
    usdPerKwh: number | null;
  } | null;
};
