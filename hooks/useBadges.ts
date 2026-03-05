import { getApp } from '@react-native-firebase/app';
import { collection, getFirestore, onSnapshot } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';

export interface BadgeNFTMetadata {
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number; // 500 = 5%
  mintFeeSOL: number;           // 0.001
}

export interface Badge {
  id: string;
  emoji: string;
  name: string;
  desc: string;
  pts: number;
  rarity: string;
  category: 'squats' | 'streak' | 'special';
  nft: BadgeNFTMetadata;
  earned: boolean;
  earnedAt?: number;
  mintedAt?: number;
  nftMint?: string; // on-chain mint address
}

const NFT_DEFAULTS: BadgeNFTMetadata = {
  symbol: 'KINLOG',
  uri: '',
  sellerFeeBasisPoints: 250,
  mintFeeSOL: 0.001,
};

export const ALL_BADGES: Omit<Badge, 'earned' | 'earnedAt' | 'mintedAt' | 'nftMint'>[] = [
  // 🏋️ 스쿼트 횟수
  { id: 'squats_30',   category: 'squats',  emoji: '💪', name: 'First Set',       desc: 'Complete 30 squats',    pts: 100,  rarity: 'Common',    nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_30.json'   } },
  { id: 'squats_60',   category: 'squats',  emoji: '🔑', name: 'Double Down',     desc: 'Complete 60 squats',    pts: 150,  rarity: 'Common',    nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_60.json'   } },
  { id: 'squats_90',   category: 'squats',  emoji: '💯', name: 'Century',         desc: 'Complete 90 squats',    pts: 200,  rarity: 'Uncommon',  nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_90.json'   } },
  { id: 'squats_150',  category: 'squats',  emoji: '⚡', name: 'Squat Machine',   desc: 'Complete 150 squats',   pts: 300,  rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_150.json'  } },
  { id: 'squats_300',  category: 'squats',  emoji: '🏆', name: 'Squat Legend',    desc: 'Complete 300 squats',   pts: 500,  rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_300.json'  } },
  { id: 'squats_600',  category: 'squats',  emoji: '👑', name: 'Squat Immortal',  desc: 'Complete 600 squats',   pts: 1000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_600.json'  } },

  // 🔥 스트릭
  { id: 'streak_7',    category: 'streak',  emoji: '🔥', name: 'Week Warrior',    desc: '7 days in a row',       pts: 200,  rarity: 'Common',    nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_7.json'    } },
  { id: 'streak_14',   category: 'streak',  emoji: '💪', name: 'Two Weeks',       desc: '14 days in a row',      pts: 300,  rarity: 'Uncommon',  nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_14.json'   } },
  { id: 'streak_30',   category: 'streak',  emoji: '🌟', name: 'Monthly Grind',   desc: '30 days in a row',      pts: 500,  rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_30.json'   } },
  { id: 'streak_60',   category: 'streak',  emoji: '⚡', name: 'Two Months',      desc: '60 days in a row',      pts: 700,  rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_60.json'   } },
  { id: 'streak_90',   category: 'streak',  emoji: '🚀', name: 'Three Months',    desc: '90 days in a row',      pts: 1000, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_90.json'   } },
  { id: 'streak_120',  category: 'streak',  emoji: '💎', name: 'Four Months',     desc: '120 days in a row',     pts: 1200, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_120.json'  } },
  { id: 'streak_150',  category: 'streak',  emoji: '🌙', name: 'Five Months',     desc: '150 days in a row',     pts: 1500, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_150.json'  } },
  { id: 'streak_180',  category: 'streak',  emoji: '🏆', name: 'Half Year',       desc: '180 days in a row',     pts: 2000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_180.json'  } },
  { id: 'streak_210',  category: 'streak',  emoji: '👊', name: 'Seven Months',    desc: '210 days in a row',     pts: 2200, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_210.json'  } },
  { id: 'streak_240',  category: 'streak',  emoji: '🌈', name: 'Eight Months',    desc: '240 days in a row',     pts: 2500, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_240.json'  } },
  { id: 'streak_270',  category: 'streak',  emoji: '☀️', name: 'Nine Months',     desc: '270 days in a row',     pts: 2800, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_270.json'  } },
  { id: 'streak_360',  category: 'streak',  emoji: '👑', name: 'Full Year',       desc: '360 days in a row',     pts: 5000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_360.json'  } },

  // ✦ 특별
  { id: 'first_rep',   category: 'special', emoji: '🏋️', name: 'First Rep',       desc: 'Complete your first workout', pts: 100, rarity: 'Common', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/first_rep.json'  } },
  { id: 'perfect_week',category: 'special', emoji: '🎯', name: 'Perfect Week',    desc: 'Work out 7 days in a week',   pts: 500, rarity: 'Rare',   nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/perfect_week.json'} },
  { id: 'speed_king',  category: 'special', emoji: '⚡', name: 'Speed King',      desc: '30 squats under 10 min',      pts: 400, rarity: 'Epic',   nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/speed_king.json' } },
];

export function useBadges(address: string | null) {
  const [badges, setBadges] = useState<Badge[]>(
    ALL_BADGES.map(b => ({ ...b, earned: false }))
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) {
      setBadges(ALL_BADGES.map(b => ({ ...b, earned: false })));
      setLoading(false);
      return;
    }

    const db = getFirestore(getApp());
    const badgesRef = collection(db, 'users', address, 'badges');

    const unsubscribe = onSnapshot(badgesRef, snapshot => {
      const earnedMap: Record<string, { earnedAt: number; mintedAt?: number; nftMint?: string }> = {};
      snapshot.docs.forEach(d => {
        if (d.data().earned) {
          earnedMap[d.id] = {
            earnedAt: d.data().earnedAt ?? 0,
            mintedAt: d.data().mintedAt,
            nftMint: d.data().nftMint,
          };
        }
      });

      setBadges(ALL_BADGES.map(b => ({
        ...b,
        earned: !!earnedMap[b.id],
        earnedAt: earnedMap[b.id]?.earnedAt,
        mintedAt: earnedMap[b.id]?.mintedAt,
        nftMint: earnedMap[b.id]?.nftMint,
      })));
      setLoading(false);
    });

    return unsubscribe;
  }, [address]);

  return { badges, loading };
}
