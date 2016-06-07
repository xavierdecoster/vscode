/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./gotoError';
import * as nls from 'vs/nls';
import {onUnexpectedError} from 'vs/base/common/errors';
import {Emitter} from 'vs/base/common/event';
import {CommonKeybindings, KeyCode, KeyMod} from 'vs/base/common/keyCodes';
import {IDisposable, dispose} from 'vs/base/common/lifecycle';
import Severity from 'vs/base/common/severity';
import * as strings from 'vs/base/common/strings';
import URI from 'vs/base/common/uri';
import {TPromise} from 'vs/base/common/winjs.base';
import * as dom from 'vs/base/browser/dom';
import {renderHtml} from 'vs/base/browser/htmlContentRenderer';
import {IKeybindingContextKey, IKeybindingService} from 'vs/platform/keybinding/common/keybindingService';
import {IMarker, IMarkerService} from 'vs/platform/markers/common/markers';
import {ITelemetryService} from 'vs/platform/telemetry/common/telemetry';
import {Position} from 'vs/editor/common/core/position';
import {Range} from 'vs/editor/common/core/range';
import {EditorAction} from 'vs/editor/common/editorAction';
import {Behaviour} from 'vs/editor/common/editorActionEnablement';
import * as editorCommon from 'vs/editor/common/editorCommon';
import {CommonEditorRegistry, ContextKey, EditorActionDescriptor} from 'vs/editor/common/editorCommonExtensions';
import {ICodeEditor} from 'vs/editor/browser/editorBrowser';
import {EditorBrowserRegistry} from 'vs/editor/browser/editorBrowserExtensions';
import {PeekViewWidget} from 'vs/editor/contrib/zoneWidget/browser/peekViewWidget';
import {getCodeActions, IQuickFix2} from 'vs/editor/contrib/quickFix/common/quickFix';

class MarkerModel {

	private _editor: ICodeEditor;
	private _markers: IMarker[];
	private _nextIdx: number;
	private _toUnbind: IDisposable[];
	private _ignoreSelectionChange: boolean;
	private _onCurrentMarkerChanged: Emitter<IMarker>;
	private _onMarkerSetChanged: Emitter<MarkerModel>;

	constructor(editor: ICodeEditor, markers: IMarker[]) {
		this._editor = editor;
		this._markers = null;
		this._nextIdx = -1;
		this._toUnbind = [];
		this._ignoreSelectionChange = false;
		this._onCurrentMarkerChanged = new Emitter<IMarker>();
		this._onMarkerSetChanged = new Emitter<MarkerModel>();
		this.setMarkers(markers);

		// listen on editor
		this._toUnbind.push(this._editor.onDidDispose(() => this.dispose()));
		this._toUnbind.push(this._editor.onDidChangeCursorPosition(() => {
			if (!this._ignoreSelectionChange) {
				this._nextIdx = -1;
			}
		}));
	}

	public get onCurrentMarkerChanged() {
		return this._onCurrentMarkerChanged.event;
	}

	public get onMarkerSetChanged() {
		return this._onMarkerSetChanged.event;
	}

	public setMarkers(markers: IMarker[]): void {
		// assign
		this._markers = markers || [];

		// sort markers
		this._markers.sort((left, right) => Severity.compare(left.severity, right.severity) || Range.compareRangesUsingStarts(left, right));

		this._nextIdx = -1;
		this._onMarkerSetChanged.fire(this);
	}

	public withoutWatchingEditorPosition(callback: () => void): void {
		this._ignoreSelectionChange = true;
		try {
			callback();
		} finally {
			this._ignoreSelectionChange = false;
		}
	}

	private initIdx(fwd: boolean): void {
		var found = false;
		var position = this._editor.getPosition();
		for (var i = 0, len = this._markers.length; i < len && !found; i++) {
			var pos = { lineNumber: this._markers[i].startLineNumber, column: this._markers[i].startColumn };
			if (position.isBeforeOrEqual(pos)) {
				this._nextIdx = i + (fwd ? 0 : -1);
				found = true;
			}
		}
		if (!found) {
			// after the last change
			this._nextIdx = fwd ? 0 : this._markers.length - 1;
		}
		if (this._nextIdx < 0) {
			this._nextIdx = this._markers.length - 1;
		}
	}

	private move(fwd: boolean): void {
		if (!this.canNavigate()) {
			this._onCurrentMarkerChanged.fire(undefined);
			return;
		}

		if (this._nextIdx === -1) {
			this.initIdx(fwd);

		} else if (fwd) {
			this._nextIdx += 1;
			if (this._nextIdx >= this._markers.length) {
				this._nextIdx = 0;
			}
		} else {
			this._nextIdx -= 1;
			if (this._nextIdx < 0) {
				this._nextIdx = this._markers.length - 1;
			}
		}
		var marker = this._markers[this._nextIdx];
		this._onCurrentMarkerChanged.fire(marker);
	}

	public canNavigate(): boolean {
		return this._markers.length > 0;
	}

	public next(): void {
		this.move(true);
	}

	public previous(): void {
		this.move(false);
	}

	public goTo(pos: editorCommon.IPosition): void {
		for (var i = 0; i < this._markers.length; i++) {
			var marker = this._markers[i];
			if (marker.startLineNumber <= pos.lineNumber && marker.endLineNumber >= pos.lineNumber
				&& marker.startColumn <= pos.column && marker.endColumn >= pos.column) {
				this._onCurrentMarkerChanged.fire(marker);
				return;
			}
		}
		return null;
	}

	public get stats(): { errors: number; others: number; } {
		let errors = 0;
		let others = 0;

		for (let marker of this._markers) {
			if (marker.severity === Severity.Error) {
				errors += 1;
			} else {
				others += 1;
			}
		}
		return { errors, others };
	}

	public reveal(): void {

		if (this._nextIdx === -1) {
			return;
		}

		this.withoutWatchingEditorPosition(() => {
			var pos = new Position(this._markers[this._nextIdx].startLineNumber, this._markers[this._nextIdx].startColumn);
			this._editor.setPosition(pos);
			this._editor.revealPositionInCenter(pos);
		});
	}

	public dispose(): void {
		this._toUnbind = dispose(this._toUnbind);
	}
}

class FixesWidget {

	domNode: HTMLDivElement;

	private _disposeOnUpdate: IDisposable[] = [];
	private _listener: IDisposable;

	constructor(
		container: HTMLElement,
		@IKeybindingService private _keybindingService: IKeybindingService
	) {
		this.domNode = document.createElement('div');
		container.appendChild(this.domNode);

		this._listener = dom.addStandardDisposableListener(container, 'keydown', (e) => {
			switch (e.asKeybinding()) {
				case CommonKeybindings.LEFT_ARROW:
					this._move(true);
					// this._goLeft();
					e.preventDefault();
					e.stopPropagation();
					break;
				case CommonKeybindings.RIGHT_ARROW:
					this._move(false);
					// this._goRight();
					e.preventDefault();
					e.stopPropagation();
					break;
			}
		});
	}

	dispose(): void {
		this._disposeOnUpdate = dispose(this._disposeOnUpdate);
		this._listener = dispose(this._listener);
	}

	update(fixes: TPromise<IQuickFix2[]>): TPromise<any> {
		this._disposeOnUpdate = dispose(this._disposeOnUpdate);
		this.domNode.style.display = 'none';
		return fixes.then(fixes => this._doUpdate(fixes), onUnexpectedError);
	}

	private _doUpdate(fixes: IQuickFix2[]): void {

		dom.clearNode(this.domNode);

		if (!fixes || fixes.length === 0) {
			return;
		}

		// light bulb and label
		let quickfixhead = document.createElement('span');
		quickfixhead.className = 'quickfixhead';
		quickfixhead.appendChild(document.createTextNode(fixes.length > 1
			? nls.localize('quickfix.multiple.label', 'Suggested fixes: ')
			: nls.localize('quickfix.single.label', 'Suggested fix: ')));
		this.domNode.appendChild(quickfixhead);

		// each fix as entry
		const container = document.createElement('span');
		container.className = 'quickfixcontainer';

		fixes.forEach((fix, idx, arr) => {

			if (idx > 0) {
				let separator = document.createElement('span');
				separator.appendChild(document.createTextNode(', '));
				container.appendChild(separator);
			}

			let entry = document.createElement('a');
			entry.tabIndex = 0;
			entry.className = `quickfixentry`;
			entry.dataset['idx'] = String(idx);
			entry.dataset['next'] = String(idx < arr.length - 1 ? idx + 1 : 0);
			entry.dataset['prev'] = String(idx > 0 ? idx - 1 : arr.length - 1);
			entry.appendChild(document.createTextNode(fix.command.title));
			this._disposeOnUpdate.push(dom.addDisposableListener(entry, dom.EventType.CLICK, () => {
				this._keybindingService.executeCommand(fix.command.id, ...fix.command.arguments);
				return true;
			}));
			this._disposeOnUpdate.push(dom.addStandardDisposableListener(entry, 'keydown', (e) => {
				switch (e.asKeybinding()) {
					case CommonKeybindings.ENTER:
					case CommonKeybindings.SPACE:
						this._keybindingService.executeCommand(fix.command.id, ...fix.command.arguments);
						e.preventDefault();
						e.stopPropagation();
				}
			}));
			container.appendChild(entry);
		});

		this.domNode.appendChild(container);
		this.domNode.style.display = '';
	}

	private _move(left: boolean): void {
		let target: HTMLElement;
		if (document.activeElement.classList.contains('quickfixentry')) {
			let current = <HTMLElement> document.activeElement;
			let idx = left ? current.dataset['prev'] : current.dataset['next'];
			target = <HTMLElement>this.domNode.querySelector(`a[data-idx='${idx}']`);
		} else {
			target = <HTMLElement> this.domNode.querySelector('.quickfixentry');
		}
		target.focus();
	}
}


class MarkerNavigationWidget extends PeekViewWidget {

	private _container: HTMLElement;
	private _element: HTMLElement;
	private _fixesWidget: FixesWidget;
	private _callOnDispose: IDisposable[] = [];

	constructor(editor: ICodeEditor, private _model: MarkerModel, private _keybindingService: IKeybindingService) {
		super(editor, undefined, { showArrow: true, showFrame: false, isAccessible: true });
		this.create();
		this._wireModelAndView();
	}

	protected _fillBody(container: HTMLElement): void {
		this._container = container;

		dom.addClass(this._container, 'marker-widget');
		this._container.tabIndex = 0;
		this._container.setAttribute('role', 'tooltip');

		this._element = document.createElement('div');
		this._element.className = 'descriptioncontainer';
		this._element.setAttribute('aria-live', 'assertive');
		this._element.setAttribute('role', 'alert');
		this._container.appendChild(this._element);
		this.editor.applyFontInfo(this._element);

		this._fixesWidget = new FixesWidget(this._container, this._keybindingService);
		this._fixesWidget.domNode.classList.add('fixes');
		this._callOnDispose.push(this._fixesWidget);
	}

	public show(where: editorCommon.IPosition, heightInLines: number): void {
		super.show(where, heightInLines);
		this._container.focus();
	}

	private _wireModelAndView(): void {
		// listen to events
		this._model.onCurrentMarkerChanged(this.showAtMarker, this, this._callOnDispose);

		// update title based on stats
		let {errors, others} = this._model.stats;
		if (errors === 0 && others === 0) {
			this.setTitle(nls.localize('title.no', "No Problems"));
		} else {
			let msgErrors: string;
			if (errors > 1) {
				msgErrors = nls.localize('errors.n', "{0} Errors", errors);
			} else if (errors > 0) {
				msgErrors = nls.localize('errors.1', "1 Error");
			}
			let msgOthers: string;
			if (others > 1) {
				msgOthers = nls.localize('others.n', "{0} Others", others);
			} else if (others > 0) {
				msgOthers = nls.localize('others.1', "1 Warning");
			}

			this.setTitle(msgErrors && msgOthers
				? nls.localize('both', "{0}, {1}", msgErrors, msgOthers)
				: msgErrors || msgOthers);
		}
	}

	public showAtMarker(marker: IMarker): void {

		if (!marker) {
			return;
		}

		// update frame color
		switch (marker.severity) {
			case Severity.Error:
				this.options.frameColor = '#ff5a5a';
				break;
			case Severity.Warning:
			case Severity.Info:
				this.options.frameColor = '#5aac5a';
				break;
		}

		// update label and show
		dom.clearNode(this._element);
		this._element.appendChild(renderHtml(marker.message));

		const range = Range.lift(marker);
		const lines = strings.computeLineStarts(marker.message).length;
		this._model.withoutWatchingEditorPosition(() => this.show(range.getStartPosition(), lines + 2));

		// check for fixes and update widget
		this._fixesWidget
			.update(getCodeActions(this.editor.getModel(), range))
			.then(() => this.show(range.getStartPosition(), lines + 3));
	}

	public dispose(): void {
		this._callOnDispose = dispose(this._callOnDispose);
		super.dispose();
	}
}

class MarkerNavigationAction extends EditorAction {

	private _isNext: boolean;

	private telemetryService: ITelemetryService;

	constructor(descriptor: editorCommon.IEditorActionDescriptorData, editor: editorCommon.ICommonCodeEditor, next: boolean, @ITelemetryService telemetryService: ITelemetryService) {
		super(descriptor, editor, Behaviour.WidgetFocus | Behaviour.Writeable | Behaviour.UpdateOnModelChange);
		this.telemetryService = telemetryService;
		this._isNext = next;
	}

	public run(): TPromise<boolean> {
		var model = MarkerController.getMarkerController(this.editor).getOrCreateModel();
		this.telemetryService.publicLog('zoneWidgetShown', { mode: 'go to error' });
		if (model) {
			if (this._isNext) {
				model.next();
			} else {
				model.previous();
			}
			model.reveal();
		}
		return TPromise.as(true);
	}
}

class MarkerController implements editorCommon.IEditorContribution {

	static ID = 'editor.contrib.markerController';

	static getMarkerController(editor: editorCommon.ICommonCodeEditor): MarkerController {
		return <MarkerController>editor.getContribution(MarkerController.ID);
	}

	private _editor: ICodeEditor;
	private _model: MarkerModel;
	private _zone: MarkerNavigationWidget;
	private _callOnClose: IDisposable[] = [];
	private _markersNavigationVisible: IKeybindingContextKey<boolean>;

	constructor(
		editor: ICodeEditor,
		@IMarkerService private _markerService: IMarkerService,
		@IKeybindingService private _keybindingService: IKeybindingService
	) {
		this._editor = editor;
		this._markersNavigationVisible = this._keybindingService.createKey(CONTEXT_MARKERS_NAVIGATION_VISIBLE, false);
	}

	public getId(): string {
		return MarkerController.ID;
	}

	public dispose(): void {
		this._cleanUp();
	}

	private _cleanUp(): void {
		this._markersNavigationVisible.reset();
		this._callOnClose = dispose(this._callOnClose);
		if (this._zone) {
			this._zone.dispose();
			this._zone = null;
		}
		this._model = null;
	}

	public getOrCreateModel(): MarkerModel {

		if (this._model) {
			return this._model;
		}

		var markers = this._getMarkers();
		this._model = new MarkerModel(this._editor, markers);
		this._zone = new MarkerNavigationWidget(this._editor, this._model, this._keybindingService);
		this._markersNavigationVisible.set(true);

		this._callOnClose.push(this._model);

		this._callOnClose.push(this._editor.onDidChangeModel(() => this._cleanUp()));
		this._callOnClose.push(this._zone.onDidClose(() => this._cleanUp()));
		this._model.onCurrentMarkerChanged(marker => !marker && this._cleanUp(), undefined, this._callOnClose);
		this._markerService.onMarkerChanged(this._onMarkerChanged, this, this._callOnClose);
		return this._model;
	}

	public closeMarkersNavigation(): void {
		if (this._zone) {
			this._zone.dispose();
			this._editor.focus();
		}
	}

	private _onMarkerChanged(changedResources: URI[]): void {
		if (!changedResources.some(r => this._editor.getModel().uri.toString() === r.toString())) {
			return;
		}
		this._model.setMarkers(this._getMarkers());
	}

	private _getMarkers(): IMarker[] {
		var resource = this._editor.getModel().uri,
			markers = this._markerService.read({ resource: resource });

		return markers;
	}
}

class NextMarkerAction extends MarkerNavigationAction {
	public static ID = 'editor.action.marker.next';

	constructor(descriptor: editorCommon.IEditorActionDescriptorData, editor: editorCommon.ICommonCodeEditor, @ITelemetryService telemetryService: ITelemetryService) {
		super(descriptor, editor, true, telemetryService);
	}
}

class PrevMarkerAction extends MarkerNavigationAction {
	public static ID = 'editor.action.marker.prev';

	constructor(descriptor: editorCommon.IEditorActionDescriptorData, editor: editorCommon.ICommonCodeEditor, @ITelemetryService telemetryService: ITelemetryService) {
		super(descriptor, editor, false, telemetryService);
	}
}

var CONTEXT_MARKERS_NAVIGATION_VISIBLE = 'markersNavigationVisible';

// register actions
CommonEditorRegistry.registerEditorAction(new EditorActionDescriptor(NextMarkerAction, NextMarkerAction.ID, nls.localize('markerAction.next.label', "Go to Next Error or Warning"), {
	context: ContextKey.EditorFocus,
	primary: KeyCode.F8
}, 'Go to Next Error or Warning'));
CommonEditorRegistry.registerEditorAction(new EditorActionDescriptor(PrevMarkerAction, PrevMarkerAction.ID, nls.localize('markerAction.previous.label', "Go to Previous Error or Warning"), {
	context: ContextKey.EditorFocus,
	primary: KeyMod.Shift | KeyCode.F8
}, 'Go to Previous Error or Warning'));
CommonEditorRegistry.registerEditorCommand('closeMarkersNavigation', CommonEditorRegistry.commandWeight(50), { primary: KeyCode.Escape, secondary: [KeyMod.Shift | KeyCode.Escape] }, false, CONTEXT_MARKERS_NAVIGATION_VISIBLE, (ctx, editor, args) => {
	var controller = MarkerController.getMarkerController(editor);
	controller.closeMarkersNavigation();
});

EditorBrowserRegistry.registerEditorContribution(MarkerController);