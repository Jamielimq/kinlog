import { getApp } from '@react-native-firebase/app';
import { collection, FirebaseFirestoreTypes, getFirestore, onSnapshot } from '@react-native-firebase/firestore';
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
  // Squat Milestones (14)
  { id: 'squats_30',    category: 'squats',  emoji: '💪', name: 'First Set',       desc: 'Complete 30 squats',      pts: 100,  rarity: 'Common',    nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_30.json'    } },
  { id: 'squats_60',    category: 'squats',  emoji: '🔑', name: 'Double Down',     desc: 'Complete 60 squats',      pts: 150,  rarity: 'Common',    nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_60.json'    } },
  { id: 'squats_90',    category: 'squats',  emoji: '💯', name: 'Century',         desc: 'Complete 90 squats',      pts: 200,  rarity: 'Common',    nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_90.json'    } },
  { id: 'squats_150',   category: 'squats',  emoji: '🔥', name: 'Warming Up',      desc: 'Complete 150 squats',     pts: 300,  rarity: 'Uncommon',  nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_150.json'   } },
  { id: 'squats_300',   category: 'squats',  emoji: '⚡', name: 'Getting Serious', desc: 'Complete 300 squats',     pts: 400,  rarity: 'Uncommon',  nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_300.json'   } },
  { id: 'squats_600',   category: 'squats',  emoji: '🏋️', name: 'Squat Machine',   desc: 'Complete 600 squats',     pts: 600,  rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_600.json'   } },
  { id: 'squats_900',   category: 'squats',  emoji: '🦵', name: 'Iron Legs',       desc: 'Complete 900 squats',     pts: 800,  rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_900.json'   } },
  { id: 'squats_1500',  category: 'squats',  emoji: '🚀', name: 'Unstoppable',     desc: 'Complete 1,500 squats',   pts: 1000, rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_1500.json'  } },
  { id: 'squats_2100',  category: 'squats',  emoji: '🎖️', name: 'Quarter Master',  desc: 'Complete 2,100 squats',   pts: 1200, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_2100.json'  } },
  { id: 'squats_3000',  category: 'squats',  emoji: '🛡️', name: 'Centurion',       desc: 'Complete 3,000 squats',   pts: 1500, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_3000.json'  } },
  { id: 'squats_4500',  category: 'squats',  emoji: '⭐', name: 'Half Year Hero',  desc: 'Complete 4,500 squats',   pts: 2000, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_4500.json'  } },
  { id: 'squats_6000',  category: 'squats',  emoji: '🏆', name: 'Squat Legend',    desc: 'Complete 6,000 squats',   pts: 3000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_6000.json'  } },
  { id: 'squats_9000',  category: 'squats',  emoji: '💎', name: 'Squat Titan',     desc: 'Complete 9,000 squats',   pts: 4000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_9000.json'  } },
  { id: 'squats_10950', category: 'squats',  emoji: '👑', name: 'Squat Immortal',  desc: 'Complete 10,950 squats',  pts: 5000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/squats_10950.json' } },

  // Streak Milestones (14)
  { id: 'streak_7',    category: 'streak',  emoji: '🔥', name: 'Week Warrior',    desc: '7 days in a row',    pts: 200,  rarity: 'Common',    nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_7.json'    } },
  { id: 'streak_14',   category: 'streak',  emoji: '💪', name: 'Two Weeks',       desc: '14 days in a row',   pts: 300,  rarity: 'Uncommon',  nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_14.json'   } },
  { id: 'streak_30',   category: 'streak',  emoji: '🌟', name: 'Monthly Grind',   desc: '30 days in a row',   pts: 500,  rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_30.json'   } },
  { id: 'streak_60',   category: 'streak',  emoji: '⚡', name: 'Two Months',      desc: '60 days in a row',   pts: 700,  rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_60.json'   } },
  { id: 'streak_90',   category: 'streak',  emoji: '🚀', name: 'Three Months',    desc: '90 days in a row',   pts: 1000, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_90.json'   } },
  { id: 'streak_120',  category: 'streak',  emoji: '💎', name: 'Four Months',     desc: '120 days in a row',  pts: 1200, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_120.json'  } },
  { id: 'streak_150',  category: 'streak',  emoji: '🌙', name: 'Five Months',     desc: '150 days in a row',  pts: 1500, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_150.json'  } },
  { id: 'streak_180',  category: 'streak',  emoji: '🏆', name: 'Half Year',       desc: '180 days in a row',  pts: 2000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_180.json'  } },
  { id: 'streak_210',  category: 'streak',  emoji: '👊', name: 'Seven Months',    desc: '210 days in a row',  pts: 2200, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_210.json'  } },
  { id: 'streak_240',  category: 'streak',  emoji: '🌈', name: 'Eight Months',    desc: '240 days in a row',  pts: 2500, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_240.json'  } },
  { id: 'streak_270',  category: 'streak',  emoji: '☀️', name: 'Nine Months',     desc: '270 days in a row',  pts: 2800, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_270.json'  } },
  { id: 'streak_300',  category: 'streak',  emoji: '🗻', name: 'Ten Months',      desc: '300 days in a row',  pts: 3200, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_300.json'  } },
  { id: 'streak_330',  category: 'streak',  emoji: '🌊', name: 'Eleven Months',   desc: '330 days in a row',  pts: 3800, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_330.json'  } },
  { id: 'streak_365',  category: 'streak',  emoji: '👑', name: 'Full Year',       desc: '365 days in a row',  pts: 5000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/streak_365.json'  } },

  // Special Badges (4)
  { id: 'first_rep',    category: 'special', emoji: '🏋️', name: 'First Rep',      desc: 'Complete your first workout',    pts: 100,  rarity: 'Common',    nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/first_rep.json'     } },
  { id: 'perfect_week', category: 'special', emoji: '🎯', name: 'Perfect Week',   desc: 'Work out 7 days in a week',      pts: 500,  rarity: 'Rare',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/perfect_week.json'  } },
  { id: 'perfect_month',category: 'special', emoji: '📅', name: 'Perfect Month',  desc: 'Work out every day for a month', pts: 1500, rarity: 'Epic',      nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/perfect_month.json' } },
  { id: 'skr_staker',   category: 'special', emoji: '🔮', name: 'SKR Staker',      desc: 'Staking 1+ SKR tokens',        pts: 2000, rarity: 'Legendary', nft: { ...NFT_DEFAULTS, uri: 'https://kinlog.app/nft/skr_staker.json'    } },
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

    const unsubscribe = onSnapshot(badgesRef, (snapshot: FirebaseFirestoreTypes.QuerySnapshot) => {
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
