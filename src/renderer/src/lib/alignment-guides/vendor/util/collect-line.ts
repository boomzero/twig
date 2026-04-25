import { type FabricObject, Point, type TOriginX, type TOriginY } from 'fabric';
import type { AligningGuidelines } from '..';
import type { LineProps } from '../typedefs';
import { getDistanceList } from './basic';

export function collectLine(
  this: AligningGuidelines,
  target: FabricObject,
  points: Point[],
) {
  const list = this.getGuidePoints(target);
  const margin = this.margin / this.canvas.getZoom();
  const opts = { target, list, points, margin };
  const vLines = collectPoints.call(this, { ...opts, type: 'x' });
  const hLines = collectPoints.call(this, { ...opts, type: 'y' });

  return { vLines, hLines };
}

type CollectItemLineProps = {
  target: FabricObject;
  list: Point[];
  points: Point[];
  margin: number;
  type: 'x' | 'y';
};
const originArr: [TOriginX, TOriginY][] = [
  ['left', 'top'],
  ['right', 'top'],
  ['right', 'bottom'],
  ['left', 'bottom'],
  ['center', 'center'],
];
function collectPoints(this: AligningGuidelines, props: CollectItemLineProps) {
  const { target, list, points, margin, type } = props;
  const res: LineProps[] = [];
  const arr: ReturnType<typeof getDistanceList>[] = [];
  let min = Infinity;
  for (const item of list) {
    const o = getDistanceList(item, points, type);
    arr.push(o);
    if (min > o.dis) min = o.dis;
  }
  if (min > margin) return res;
  let b = false;
  for (let i = 0; i < list.length; i++) {
    if (arr[i].dis != min) continue;
    for (const item of arr[i].arr) {
      res.push({ origin: list[i], target: item });
    }

    if (b) continue;
    b = true;
    const d = arr[i].arr[0][type] - list[i][type];
    // It will change the original data, and the next time we collect y, use the modified data.
    list.forEach((item) => {
      item[type] += d;
    });
    const delta = type === 'x' ? new Point(d, 0) : new Point(0, d);
    this.applyTargetGuidePointSnap(target, list[i], originArr[i], delta, i);
    target.setCoords();
  }

  return res;
}
