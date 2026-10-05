import { useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { BOARD_SQUARES } from '../../lib/lockedIn/program'

const C = {
  cell: '#F5F4F1', line: '#E7E5E4', sub: '#78716C',
  dark: '#2D2926', amber: '#D97706', amberBg: '#FFFBEB',
}

const SIDE = Math.sqrt(BOARD_SQUARES)
const GAP = 8

/**
 * The 5×5 board, numbered 1 to 25 on screen (0 to 24 on chain). Highlights the Square tapped before
 * picking, the participant's picked Square, and, once revealed, the ORE round's winning square.
 * `motherlode` shows a Legendary result: 💎 in place of the picked Square's number. The Motherlode
 * belongs to the round, not to a Square, so it is only ever shown after the result.
 */
export function SquareGrid({ selected, picked, winning, motherlode, onSelect }: {
  selected?: number | null
  picked?: number | null
  winning?: number | null
  motherlode?: boolean
  onSelect?: (square: number) => void // none: the board can't be tapped
}) {
  // Every cell gets the same fixed size from the board's measured width, so what a cell holds (a
  // number, or the larger 💎) can't change its size. Until the first measure, flex shares the row.
  const [width, setWidth] = useState(0)
  const side = width > 0 ? (width - GAP * (SIDE - 1)) / SIDE : 0
  const box = side > 0 ? { width: side, height: side } : s.cellFlex
  return (
    <View style={s.grid} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
      {Array.from({ length: SIDE }, (_, row) => (
        <View key={row} style={s.row}>
          {Array.from({ length: SIDE }, (_, col) => {
            const i = row * SIDE + col
            const isPicked = i === picked
            const isWinning = i === winning
            const isSelected = i === selected
            return (
              <TouchableOpacity
                key={i}
                style={[
                  s.cell,
                  box,
                  isSelected && s.selected,
                  isPicked && s.picked,
                  isWinning && s.winning,
                  isPicked && isWinning && s.pickedWinning,
                  isPicked && motherlode && (isWinning ? s.gemWinning : s.gemCell),
                ]}
                onPress={onSelect ? () => onSelect(i) : undefined}
                disabled={!onSelect}
                activeOpacity={0.7}
              >
                {isPicked && motherlode ? (
                  <Text style={s.gem}>💎</Text>
                ) : (
                  <Text style={[s.num, isSelected && s.numSelected, (isPicked || isWinning) && s.numOn]}>{i + 1}</Text>
                )}
              </TouchableOpacity>
            )
          })}
        </View>
      ))}
    </View>
  )
}

/** What the board's marks mean, shown under it once the result is revealed. */
export function SquareLegend({ motherlode }: { motherlode?: boolean }) {
  return (
    <View style={s.legend}>
      <View style={s.legendItem}>
        <View style={[s.swatch, { backgroundColor: C.dark }]} />
        <Text style={s.legendText}>Your Square</Text>
      </View>
      <View style={s.legendItem}>
        <View style={[s.swatch, { backgroundColor: C.amber }]} />
        <Text style={s.legendText}>Winning Square</Text>
      </View>
      {motherlode && (
        <View style={s.legendItem}>
          <Text style={s.legendGem}>💎</Text>
          <Text style={s.legendText}>Motherlode</Text>
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  grid: { gap: GAP },
  row:  { flexDirection: 'row', gap: GAP },
  cell: {
    borderRadius: 12, backgroundColor: C.cell,
    borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center',
  },
  cellFlex:      { flex: 1, aspectRatio: 1 },
  selected:      { backgroundColor: C.amberBg, borderColor: C.amber, borderWidth: 2 },
  picked:        { backgroundColor: C.dark, borderColor: C.dark },
  winning:       { backgroundColor: C.amber, borderColor: C.amber },
  pickedWinning: { borderColor: C.dark, borderWidth: 3 },
  num:           { fontSize: 15, fontWeight: '700', color: C.sub },
  numSelected:   { color: C.amber },
  numOn:         { color: '#fff' },
  gem:           { fontSize: 28 },
  // A Legendary pick's cell stays dark (the app's dark, as on the Join button) even if it is also
  // the winning square; then an amber edge keeps the legend true.
  gemCell:       { backgroundColor: C.dark, borderColor: C.dark },
  gemWinning:    { backgroundColor: C.dark, borderColor: C.amber, borderWidth: 3 },

  // Wraps to a second line if the three items don't fit.
  legend:     { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 16, rowGap: 6, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch:     { width: 12, height: 12, borderRadius: 3 },
  legendGem:  { fontSize: 12 },
  legendText: { fontSize: 13, color: C.sub },
})
