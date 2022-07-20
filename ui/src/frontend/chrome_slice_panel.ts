// Copyright (C) 2019 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use size file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as m from 'mithril';

import {sqliteString} from '../base/string_utils';
import {Actions} from '../common/actions';
import {Arg, ArgsTree, isArgTreeArray, isArgTreeMap} from '../common/arg_types';
import {timeToCode} from '../common/time';

import {FlowPoint, globals, SliceDetails} from './globals';
import {PanelSize} from './panel';
import {PopupMenuButton, PopupMenuItem} from './popup_menu';
import {verticalScrollToTrack} from './scroll_helper';
import {SlicePanel} from './slice_panel';

// Table row contents is one of two things:
// 1. Key-value pair
interface TableRow {
  kind: 'TableRow';
  key: string;
  value: Arg;

  // Whether it's an argument (from the `args` table) or whether it's a property
  // of the slice (i.e. `dur`, coming from `slice` table). Args have additional
  // actions associated with them.
  isArg: boolean;

  // A full key for the arguments displayed in a tree.
  full_key?: string;
}

// 2. Common prefix for values in an array
interface TableHeader {
  kind: 'TableHeader';
  header: string;
}

type RowContents = TableRow|TableHeader;

function isTableHeader(contents: RowContents): contents is TableHeader {
  return contents.kind === 'TableHeader';
}

function appendPrefix(p1: string, p2: string): string {
  if (p1.length === 0) {
    return p2;
  }
  return `${p1}.${p2}`;
}

// During building the table, sometimes we want to add an extra cell to the
// table. It might be either an index of array element (represented as number),
// a special indentation cell to ensure minimum column width when indenting
// an object ('whitespace' literal) or just be absent ('none' literal).
type ExtraCell = number|'whitespace'|'none';

interface Row {
  // How many columns (empty or with an index) precede a key
  indentLevel: number;
  extraCell: ExtraCell;
  // Optional tooltip to be displayed on the key. Used to display the full key,
  // which has to be reconstructed from the information that might not even be
  // visible on the screen otherwise.
  tooltip?: string;
  contents: RowContents;
}

class TableBuilder {
  stack: ExtraCell[] = [];

  // Row data generated by builder
  rows: Row[] = [];

  // Maximum indent level of a key, used to determine total number of columns
  maxIndent = 0;

  // Add a key-value pair into the table
  add(key: string, value: Arg) {
    this.rows.push({
      indentLevel: 0,
      extraCell: 'none',
      contents: {kind: 'TableRow', key, value, isArg: false},
    });
  }

  // Add arguments tree into the table
  addTree(tree: ArgsTree) {
    this.addTreeInternal(tree, '', '');
  }

  // Return indent level and index for a fresh row
  private prepareRow(): [number, ExtraCell] {
    const level = this.stack.length;
    let index: ExtraCell = 'none';
    if (level > 0) {
      index = this.stack[level - 1];
      if (index !== -1) {
        this.stack[level - 1] = 'none';
      }
    }
    this.maxIndent = Math.max(this.maxIndent, level);
    return [level, index];
  }

  private addTreeInternal(
      record: ArgsTree, prefix: string, completePrefix: string) {
    if (isArgTreeArray(record)) {
      // Add the current prefix as a separate row
      const row = this.prepareRow();
      this.rows.push({
        indentLevel: row[0],
        extraCell: row[1],
        contents: {kind: 'TableHeader', header: prefix},
        tooltip: completePrefix,
      });

      for (let i = 0; i < record.length; i++) {
        // Push the current array index to the stack.
        this.stack.push(i);
        // Prefix is empty for array elements because we don't want to repeat
        // the common prefix
        this.addTreeInternal(record[i], '', `${completePrefix}[${i}]`);
        this.stack.pop();
      }
    } else if (isArgTreeMap(record)) {
      const entries = Object.entries(record);
      if (entries.length === 1) {
        // Don't want to create a level of indirection in case object contains
        // only one value; think of it like file browser in IDEs not showing
        // intermediate nodes for common hierarchy corresponding to Java package
        // prefix (e.g. "com/google/perfetto").
        //
        // In this case, add key as a prefix part.
        const [key, value] = entries[0];
        this.addTreeInternal(
            value,
            appendPrefix(prefix, key),
            appendPrefix(completePrefix, key));
      } else {
        if (prefix.length > 0) {
          const row = this.prepareRow();
          this.rows.push({
            indentLevel: row[0],
            extraCell: row[1],
            contents: {kind: 'TableHeader', header: prefix},
            tooltip: completePrefix,
          });
          this.stack.push('whitespace');
        }
        for (const [key, value] of entries) {
          this.addTreeInternal(value, key, appendPrefix(completePrefix, key));
        }
        if (prefix.length > 0) {
          this.stack.pop();
        }
      }
    } else {
      // Leaf value in the tree: add to the table
      const row = this.prepareRow();
      this.rows.push({
        indentLevel: row[0],
        extraCell: row[1],
        contents: {
          kind: 'TableRow',
          key: prefix,
          value: record,
          full_key: completePrefix,
          isArg: true,
        },
        tooltip: completePrefix,
      });
    }
  }
}

export class ChromeSliceDetailsPanel extends SlicePanel {
  view() {
    const sliceInfo = globals.sliceDetails;
    if (sliceInfo.ts !== undefined && sliceInfo.dur !== undefined &&
        sliceInfo.name !== undefined) {
      const defaultBuilder = new TableBuilder();
      defaultBuilder.add('Name', sliceInfo.name);
      defaultBuilder.add(
          'Category',
          !sliceInfo.category || sliceInfo.category === '[NULL]' ?
              'N/A' :
              sliceInfo.category);
      defaultBuilder.add('Start time', timeToCode(sliceInfo.ts));
      if (sliceInfo.absTime !== undefined) {
        defaultBuilder.add('Absolute Time', sliceInfo.absTime);
      }
      defaultBuilder.add(
          'Duration', this.computeDuration(sliceInfo.ts, sliceInfo.dur));
      if (sliceInfo.threadTs !== undefined &&
          sliceInfo.threadDur !== undefined) {
        // If we have valid thread duration, also display a percentage of
        // |threadDur| compared to |dur|.
        const threadDurFractionSuffix = sliceInfo.threadDur === -1 ?
            '' :
            ` (${(sliceInfo.threadDur / sliceInfo.dur * 100).toFixed(2)}%)`;
        defaultBuilder.add(
            'Thread duration',
            this.computeDuration(sliceInfo.threadTs, sliceInfo.threadDur) +
                threadDurFractionSuffix);
      }

      for (const [key, value] of this.getProcessThreadDetails(sliceInfo)) {
        if (value !== undefined) {
          defaultBuilder.add(key, value);
        }
      }

      defaultBuilder.add(
          'Slice ID', sliceInfo.id ? sliceInfo.id.toString() : 'Unknown');
      if (sliceInfo.description) {
        for (const [key, value] of sliceInfo.description) {
          defaultBuilder.add(key, value);
        }
      }

      const rightPanel = new Map<string, TableBuilder>();

      const immediatelyPrecedingByFlowSlices = [];
      const immediatelyFollowingByFlowSlices = [];
      for (const flow of globals.connectedFlows) {
        if (flow.begin.sliceId === sliceInfo.id) {
          immediatelyFollowingByFlowSlices.push(
              {flow: flow.end, dur: flow.dur});
        }
        if (flow.end.sliceId === sliceInfo.id) {
          immediatelyPrecedingByFlowSlices.push(
              {flow: flow.begin, dur: flow.dur});
        }
      }

      // This is Chrome-specific bits:
      const isRunTask = sliceInfo.name === 'ThreadControllerImpl::RunTask' ||
          sliceInfo.name === 'ThreadPool_RunTask';
      const isPostTask = sliceInfo.name === 'ThreadPool_PostTask' ||
          sliceInfo.name === 'SequenceManager PostTask';

      // RunTask and PostTask are always same-process, so we can skip
      // emitting process name for them.
      this.fillFlowPanel(
          'Preceding flows',
          immediatelyPrecedingByFlowSlices,
          !isRunTask,
          rightPanel);
      this.fillFlowPanel(
          'Following flows',
          immediatelyFollowingByFlowSlices,
          !isPostTask,
          rightPanel);

      const argsBuilder = new TableBuilder();
      this.fillArgs(sliceInfo, argsBuilder);
      rightPanel.set('Arguments', argsBuilder);

      return m(
          '.details-panel',
          m('.details-panel-heading', m('h2', `Slice Details`)),
          m('.details-table-multicolumn', [
            this.renderTable(defaultBuilder, '.half-width-panel'),
            this.renderTables(rightPanel, '.half-width-panel'),
          ]));
    } else {
      return m(
          '.details-panel',
          m('.details-panel-heading',
            m(
                'h2',
                `Slice Details`,
                )));
    }
  }

  private fillFlowPanel(
      name: string, flows: {flow: FlowPoint, dur: number}[],
      includeProcessName: boolean, result: Map<string, TableBuilder>) {
    if (flows.length === 0) return;

    const builder = new TableBuilder();
    for (const {flow, dur} of flows) {
      builder.add('Slice', {
        kind: 'SLICE',
        sliceId: flow.sliceId,
        trackId: globals.state.uiTrackIdByTraceTrackId[flow.trackId],
        description: flow.sliceChromeCustomName === undefined ?
            flow.sliceName :
            flow.sliceChromeCustomName,
      });
      builder.add('Delay', timeToCode(dur));
      builder.add(
          'Thread',
          includeProcessName ? `${flow.threadName} (${flow.processName})` :
                               flow.threadName);
    }
    result.set(name, builder);
  }

  renderCanvas(_ctx: CanvasRenderingContext2D, _size: PanelSize) {}

  fillArgs(slice: SliceDetails, builder: TableBuilder) {
    if (slice.argsTree && slice.args) {
      // Parsed arguments are available, need only to iterate over them to get
      // slice references
      for (const [key, value] of slice.args) {
        if (typeof value !== 'string') {
          builder.add(key, value);
        }
      }
      builder.addTree(slice.argsTree);
    } else if (slice.args) {
      // Parsing has failed, but arguments are available: display them in a flat
      // 2-column table
      for (const [key, value] of slice.args) {
        builder.add(key, value);
      }
    }
  }

  private getArgumentContextMenuItems(argument: TableRow): PopupMenuItem[] {
    if (argument.full_key === undefined) return [];
    if (typeof argument.value !== 'string') return [];
    const argValue: string = argument.value;

    const fullKey = argument.full_key;
    return [
      {
        itemType: 'regular',
        text: 'Copy full key',
        callback: () => {
          navigator.clipboard.writeText(fullKey);
        },
      },
      {
        itemType: 'regular',
        text: 'Find slices with the same arg value',
        callback: () => {
          globals.dispatch(Actions.executeQuery({
            queryId: `slices_with_arg_value_${fullKey}=${argValue}`,
            query: `
              select slice.* 
              from slice
              join args using (arg_set_id)
              where key=${sqliteString(fullKey)} and display_value=${
                sqliteString(argValue)}
          `,
          }));
        },
      },
      {
        itemType: 'regular',
        text: 'Visualise argument values',
        callback: () => {
          globals.dispatch(Actions.addVisualisedArg({argName: fullKey}));
        },
      },
    ];
  }

  renderTables(
      builders: Map<string, TableBuilder>,
      additionalClasses: string = ''): m.Vnode {
    const rows: m.Vnode[] = [];
    for (const [name, builder] of builders) {
      rows.push(m('h3', name));
      rows.push(this.renderTable(builder));
    }
    return m(`div${additionalClasses}`, rows);
  }

  renderTable(builder: TableBuilder, additionalClasses: string = ''): m.Vnode {
    const rows: m.Vnode[] = [];
    const keyColumnCount = builder.maxIndent + 1;
    for (const row of builder.rows) {
      const renderedRow: m.Vnode[] = [];
      let indent = row.indentLevel;
      if (row.extraCell !== 'none') {
        indent--;
      }

      if (indent > 0) {
        renderedRow.push(m('td.no-highlight', {colspan: indent}));
      }

      if (row.extraCell === 'whitespace') {
        renderedRow.push(m('td.no-highlight.padding', {class: 'array-index'}));
      } else if (row.extraCell !== 'none') {
        renderedRow.push(m('td', {class: 'array-index'}, `[${row.extraCell}]`));
      }

      if (isTableHeader(row.contents)) {
        renderedRow.push(m(
            'th',
            {colspan: keyColumnCount + 1 - row.indentLevel, title: row.tooltip},
            row.contents.header));
      } else {
        const contents: any[] = [row.contents.key];
        if (row.contents.isArg) {
          contents.push(m(PopupMenuButton, {
            icon: 'arrow_drop_down',
            items: this.getArgumentContextMenuItems(row.contents),
          }));
        }

        renderedRow.push(
            m('th',
              {colspan: keyColumnCount - row.indentLevel, title: row.tooltip},
              contents));
        const value = row.contents.value;
        if (typeof value === 'string') {
          renderedRow.push(m('td.value', value));
        } else {
          // Type of value being a record is not propagated into the callback
          // for some reason, extracting necessary parts as constants instead.
          const sliceId = value.sliceId;
          const trackId = value.trackId;
          renderedRow.push(
              m('td',
                m('i.material-icons.grey',
                  {
                    onclick: () => {
                      globals.makeSelection(Actions.selectChromeSlice(
                          {id: sliceId, trackId, table: 'slice'}));
                      // Ideally we want to have a callback to
                      // findCurrentSelection after this selection has been
                      // made. Here we do not have the info for horizontally
                      // scrolling to ts.
                      verticalScrollToTrack(trackId, true);
                    },
                    title: 'Go to destination slice',
                  },
                  'call_made'),
                value.description));
        }
      }

      rows.push(m('tr', renderedRow));
    }

    return m(`table.auto-layout${additionalClasses}`, rows);
  }
}
