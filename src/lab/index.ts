import { JupyterLab, JupyterLabPlugin } from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { DocumentManager, IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { INotebookModel, INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { JSONObject } from '@phosphor/coreutils';
import { DisposableDelegate, IDisposable } from '@phosphor/disposable';
import { loadHistory as loadHistory } from '../history/load';
import { storeHistory } from '../history/store';
import { MarkerManager } from '../packages/cell';
import { GatherController, GatherModel, GatherState } from '../packages/gather';
import { DataflowAnalyzer } from '../slicing/DataflowAnalysis';
import { ExecutionLogSlicer } from '../slicing/ExecutionSlicer';
import { log } from '../utils/log';
import { ExecutionLogger } from './execution-logger';
import { GatherModelRegistry, getGatherModelForActiveNotebook } from './gather-registry';
import { NotifactionExtension as NotificationExtension } from './notification';
import { ResultsHighlighter } from './results';
//import {Widget} from '@phoshpor/widgets';
import { Widget } from '@phosphor/widgets';
import '../../style/index.css';
import '../../style/lab-vars.css';
import { Clipboard } from './gather-actions';
import {DisplayData} from '../packages/displaydata'
import {nbformat} from "@jupyterlab/coreutils"
import { RenderMimeRegistry, standardRendererFactories as initialFactories } from '@jupyterlab/rendermime';

const extension: JupyterLabPlugin<void> = {
    activate: activateExtension,
    id: 'gather:gatherPlugin',
    requires: [ICommandPalette, INotebookTracker, IDocumentManager],
    autoStart: true
};

/**
 * Extension for tracking sequences of cells executed in a notebook.
 * TODO(andrewhead): have an execution stamp that includes the kernel that executed a cell... (requires insulation in program builder)
 * TODO(andrewhead): can we run the analysis on the backend with a web-worker (specifically, def-use?)
 */
class CodeGatheringExtension implements DocumentRegistry.IWidgetExtension<NotebookPanel, INotebookModel> {

    constructor(documentManager: DocumentManager, notebooks: INotebookTracker, 
            gatherModelRegistry: GatherModelRegistry) {
        this._documentManager = documentManager;
        this._notebooks = notebooks;
        this._gatherModelRegistry = gatherModelRegistry;
    }

    createNew(notebook: NotebookPanel, notebookContext: DocumentRegistry.IContext<INotebookModel>): IDisposable {

        /*
         * For the metadata to be available, first wait for the context to be "ready."" 
         */
        notebookContext.ready.then(() => {

            let notebookModel = notebookContext.model;
            let executionLog = new ExecutionLogSlicer(new DataflowAnalyzer());
            let gatherModel = new GatherModel(executionLog);

            /*
             * Initialize reactive UI before loading the execution log from storage. This lets us
             * update the UI automatically as we populate the log.
             */
            let markerManager = new MarkerManager(gatherModel, notebook);
            new ResultsHighlighter(gatherModel, notebook, markerManager);
            new GatherController(gatherModel, this._documentManager, this._notebooks);
            
            this._gatherModelRegistry.addGatherModel(notebookModel, gatherModel);
            new ExecutionLogger(notebook, gatherModel);
            saveHistoryOnNotebookSave(notebook, gatherModel);

            loadHistory(notebookContext.model, gatherModel);
        });

        return new DisposableDelegate(() => { });
    }

    private _documentManager: DocumentManager;
    private _notebooks: INotebookTracker;
    private _gatherModelRegistry: GatherModelRegistry;
}

function saveHistoryOnNotebookSave(notebook: NotebookPanel, gatherModel: GatherModel) {
    notebook.context.saveState.connect((_, message) => {
        if (message == 'started') {
            storeHistory(notebook.model, gatherModel.executionLog);
        }
    });
}

function activateExtension(app: JupyterLab, palette: ICommandPalette, notebooks: INotebookTracker, documentManager: IDocumentManager) {

    console.log('Activating code gathering tools...');

  

    const notificationExtension = new NotificationExtension();
    app.docRegistry.addWidgetExtension('Notebook', notificationExtension);
    Clipboard.getInstance().copied.connect(() => {
        notificationExtension.showMessage("Copied cells to clipboard.");
    });

    let gatherModelRegistry = new GatherModelRegistry();
    app.docRegistry.addWidgetExtension('Notebook', new CodeGatheringExtension(documentManager, notebooks, gatherModelRegistry));



    function addCommand(command: string, label: string, execute: (options?: JSONObject) => void) {
        app.commands.addCommand(command, { label, execute });
        palette.addItem({ command, category: 'Clean Up' });
    }

    addCommand('gather:gatherToClipboard', 'Gather this result to the clipboard', () => {
        let gatherModel = getGatherModelForActiveNotebook(notebooks, gatherModelRegistry);
        if (gatherModel == null) return;
        log("Button: Clicked gather to notebook with selections", {
            selectedDefs: gatherModel.selectedDefs,
            selectedOutputs: gatherModel.selectedOutputs });
        gatherModel.addChosenSlices(...gatherModel.selectedSlices.map(sel => sel.slice));
        gatherModel.requestStateChange(GatherState.GATHER_TO_CLIPBOARD);
    });

    addCommand('gather:gatherToNotebook', 'Gather this result into a new notebook', () => {
        let gatherModel = getGatherModelForActiveNotebook(notebooks, gatherModelRegistry);
        if (gatherModel == null) return;
        if (gatherModel.selectedSlices.length >= 1) {
            log("Button: Clicked gather to notebook with selections", {
                selectedDefs: gatherModel.selectedDefs,
                selectedOutputs: gatherModel.selectedOutputs });
            gatherModel.addChosenSlices(...gatherModel.selectedSlices.map(sel => sel.slice));
            gatherModel.requestStateChange(GatherState.GATHER_TO_NOTEBOOK);
        }
    });

    addCommand('gather:gatherToScript', 'Gather this result into a new script', () => {
        let gatherModel = getGatherModelForActiveNotebook(notebooks, gatherModelRegistry);
        if (gatherModel == null) return;
        if (gatherModel.selectedSlices.length >= 1) {
            log("Button: Clicked gather to script with selections", {
                selectedDefs: gatherModel.selectedDefs,
                selectedOutputs: gatherModel.selectedOutputs });
            gatherModel.addChosenSlices(...gatherModel.selectedSlices.map(sel => sel.slice));
            gatherModel.requestStateChange(GatherState.GATHER_TO_SCRIPT);
        }
    });

    console.log("h1")
    addCommand('gather:graveyard', 'View Graveyward', () => {
        let gatherModel = getGatherModelForActiveNotebook(notebooks, gatherModelRegistry);
        if (gatherModel == null) return;

        let widget: Widget = new Widget();
        widget.id = 'graveyard-jupyterlab';
        widget.title.label = 'Graveyard';
        widget.title.closable = true;
        let history = gatherModel.executionLog.cellExecutions;
        for (var i=0; i<history.length;i++){
            let cellOutput = history[i].cell.output;
            if(cellOutput) {
                console.log(cellOutput, cellOutput.length)
                for (var x=0; x<cellOutput.length;x++) {
                    let convertedCellOutput = (cellOutput[x] as nbformat.IOutput);
                  
                    let outputWidget = new DisplayData({
                        model:convertedCellOutput,
                        rendermime: new RenderMimeRegistry({initialFactories})
                    });
                    //let outputWidget = new DisplayData(outputWidgetOptions);

                    outputWidget.id = "output" + x.toString + i.toString

                    outputWidget.title.label="graveyard-jupyterlab"
                    outputWidget.title.label ="graveyward"
                    outputWidget.title.closable = true;
                    app.shell.addToMainArea(outputWidget)
                    app.shell.activateById(outputWidget.id);




                }
            }


        }
 

        console.log("We're in the graveyard right now!")

        /*let widget: Widget = new Widget();
        widget.id = 'graveyard-jupyterlab';
        widget.title.label = 'Graveyard';
        widget.title.closable = true;

        let img = document.createElement('img');
        widget.node.appendChild(img);

        // Fetch info about a random comic
        fetch('https:////egszlpbmle.execute-api.us-east-1.amazonaws.com/prod').then(response => {
          return response.json();
        }).then(data => {
          img.src = data.img;
          img.alt = data.title;
          img.title = data.alt;
        });
        if (!widget.isAttached) {
        // Attach the widget to the main work area if it's not there
            app.shell.addToMainArea(widget);
        }
        // Activate the widget
        app.shell.activateById(widget.id);*/
    });

    // TODO: re-enable this feature for Jupyter Lab.
    /*
    addCommand('gather:gatherFromHistory', 'Compare previous versions of this result', () => {

        const panel = notebooks.currentWidget;
        if (panel && panel.content && panel.content.activeCell.model.type === 'code') {
            const activeCell = panel.content.activeCell;
            let slicer = executionLogger.executionSlicer;
            let cellModel = activeCell.model as ICodeCellModel;
            let slicedExecutions = slicer.sliceAllExecutions(new LabCell(cellModel));
            // TODO: Update this with a real gather-model and real output renderer.
            let historyModel = buildHistoryModel<IOutputModel>(new GatherModel(), activeCell.model.id, slicedExecutions);

            let widget = new HistoryViewer({
                model: historyModel,
                outputRenderer: { render: () => null }
            });

            if (!widget.isAttached) {
                app.shell.addToMainArea(widget);
            }
            app.shell.activateById(widget.id);
        }
    });
    */

    console.log('Code gathering tools have been activated.');
}

export default extension;
