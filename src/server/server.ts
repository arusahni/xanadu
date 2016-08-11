///<xreference path="./random-seed.d.ts" />
// ^^ fix this ^^
import * as _ from 'lodash';
import * as Path from 'path';
import * as Gen from 'random-seed';
import * as Http from 'http';
import * as Express from 'express';
import * as SocketIO from 'socket.io';
import Context from '../context/context';
import Game from '../context/game';
import Lobby from '../context/lobby';
import { Message, show as showMessage, createGameMessage } from '../game/messaging';
import { Player, debugDetails as playerDebugDetails, playerDetails, isAnon } from '../game/player';
import { Promise } from 'es6-promise';
import { mapToString } from '../game/map/map';
import { Logger } from '../logger';

export default class Server {
  expressApp: Express.Express;
  httpServer: Http.Server;
  io: SocketIO.Server;
  port: number;
  currentContext: Context;
  sockets: SocketIO.Socket[];
  gameNS: SocketIO.Namespace;
  debugNS: SocketIO.Namespace;
  seed: Gen.seedType;
  maxPlayers: number;
  logger: Logger;
  constructor(maxPlayers: number, port: number, seed: string, debug: boolean, logger: Logger) {
    this.maxPlayers = maxPlayers;
    this.expressApp = Express();
    this.httpServer = Http.createServer(this.expressApp);
    this.io = SocketIO(this.httpServer);
    this.port = port;
    this.logger = logger;

    this.gameNS = this.io.of('/game');

    // TODO: Don't serve debug page if debugging is off
    if (debug) {
      this.debugNS = this.io.of('/debug');
      // XXX: the server's user should probably define the logging level...
      // this.logger.level = 'debug';
    } else {
      this.debugNS = null;
    }

    this.seed = seed;
    this.sockets = [];
    // server starts out as having a lobby context
    this.currentContext = this.createEmptyLobby();

    //this.createServer();
  }

  start(): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      if (this.debugNS) {
        this.createDebugServer();
      }

      this.createServer();

      resolve(this);
    });
  }

  stop(closeCallback = _.noop): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      // TODO: handle this event on the client
      if (this.debugNS) {
        this.debugNS.removeAllListeners('server-stopped');
      }
      this.gameNS.removeAllListeners('server-stopped');
      this.httpServer.close(closeCallback);

      resolve(this);
    });
  }

  createServer() {
    const NODE_MODULES = Path.join(__dirname, '..', '..', 'node_modules');
    const PATHS = {
      CLIENT_ASSETS: Path.join(__dirname, '..', '..', 'assets', 'client'),
      CLIENT_SCRIPTS: Path.join(__dirname, '..', 'client'),
      NODE_MODULES: NODE_MODULES,
      JQUERY: Path.join(NODE_MODULES, 'jquery', 'dist'),
      BOOTSTRAP: Path.join(NODE_MODULES, 'bootstrap', 'dist')
    };

    this.expressApp.use(Express.static(PATHS.CLIENT_ASSETS));
    this.expressApp.use('/scripts', Express.static(PATHS.CLIENT_SCRIPTS));
    this.expressApp.use('/jquery', Express.static(PATHS.JQUERY));
    this.expressApp.use('/bootstrap', Express.static(PATHS.BOOTSTRAP));

    // TODO: add logger
    this.httpServer.listen(this.port, _.noop);

    this.gameNS.on('connection', (socket) => {
      this.handleConnection(socket);
    });
  }

  createDebugServer() {
    this.logger.log('debug', 'Launching the debug server...');
    this.debugNS.on('connection', (socket) => {
      socket.on('get', () => {
        let dataToSend: any = {};
        dataToSend.playerData =
          this.currentContext.players.map((player) => playerDebugDetails(player));

        if (this.currentContext instanceof Game) {
          dataToSend.gameMap = mapToString((this.currentContext as Game).map);
          dataToSend.turnNumber = (this.currentContext as Game).turnNumber;
        }

        /*
        socket.emit('debug-update', this.currentContext.players
          // pretty print the json
          .map(player => JSON.stringify(playerDebugDetails(player), null, 2))
          .join('\n'));
          */

        socket.emit('debug-update', JSON.stringify(dataToSend, null, 2));
      });
    });
  }

  handleConnection(socket: SocketIO.Socket) {
    // when people connect...
    if (this.currentContext.isAcceptingPlayers()) {
      this.acceptSocket(socket);
    } else {
      this.rejectSocket(socket);
    }
  }
  changeContext() {
    if (this.currentContext instanceof Lobby) {
      // FIXME: what about passing the rng/seed?
      this.currentContext = this.createGame();
      /*
      this.currentContext = new Game({
        players: this.currentContext.players,
        maxPlayers: this.maxPlayers,
        rng: Gen(this.seed)
      });
      */
      // message players that the game has begun
      this.sendMessage(
        createGameMessage('THE GAME HAS BEGUN!', this.currentContext.players)
      );

      // send details to players
      this.sendDetails();
      // TODO: start the round interval update
    } else {
      this.currentContext = this.createLobby(this.currentContext.players);
    }
  }
  acceptSocket(socket: SocketIO.Socket) {
    this.logger.log('info', `Server accepted socket ${socket.id}`);
    this.sockets.push(socket);

    this.addPlayer(socket.id);

    // when people send _anything_ from the client
    // the game handles the message, and then passes the server a response
    // then, the server sends the response to the client
    socket.on('message', (messageObj) => {
      this.logger.log('debug', `Socket ${socket.id}: ${JSON.stringify(messageObj)}`);

      let { isReadyForUpdate, isReadyForNextContext } = this.handleMessage(messageObj, socket);

      if (isReadyForUpdate) {
        const { messages, log } = this.currentContext.update();

        messages.forEach(message => this.sendMessage(message));
      }

      // TODO: do something with the context's player lists
      if (isReadyForNextContext) {
        this.changeContext();
      }
    });

    // when people disconnect
    socket.on('disconnect', () => {
      if (this.currentContext.hasPlayer(socket.id)) {
        const removedPlayer = this.removePlayer(socket.id);

        this.logger.log('debug', `\tPlayer ${removedPlayer.id + '--' + removedPlayer.name} disconnected`);

        if (!isAnon(removedPlayer)) {
          const disconnectMessage =
            this.currentContext.broadcastFromPlayer(`${removedPlayer.name} has left the game.`, removedPlayer);

          this.sendMessage(disconnectMessage);
        }
      } else {
        this.logger.log('debug', `Unrecognized socket ${socket.id} disconnected`);
      }
    });
  }

  rejectSocket(socket: SocketIO.Socket) {
    this.logger.log('debug', `socket ${socket.id} rejected -- game full (${this.maxPlayers} max)`);
    socket.emit('rejected-from-room');
  }

  getSocket(socketId: string, server = this) {
    return _.find(server.sockets, (s) => s.id === socketId);
  }

  addPlayer(socketId: string): void {
    this.currentContext.addPlayer(socketId);
  }

  removePlayer(socketId: string): Player {
    return this.currentContext.removePlayer(socketId);
  }

  removeSocket(socketId: string) {
    this.sockets = _.filter(this.sockets, (socket) => socket.id !== socketId);
  }

  handleMessage(messageObj, socket: SocketIO.Socket) {

    messageObj.player = this.currentContext.getPlayer(socket.id);

    this.currentContext.handleMessage(messageObj)
      .forEach(message => this.sendMessage(message));

    return {
      isReadyForNextContext: this.currentContext.isReadyForNextContext(),
      isReadyForUpdate: this.currentContext.isReadyForUpdate()
    };
  }

  // Reason for `createGame`: we may want one server but many games!
  createGame(): Game {
    return new Game(this.maxPlayers, this.currentContext.players);
  }

  createLobby(players: Player[]): Lobby {
    return new Lobby(this.maxPlayers, players);
  }

  createEmptyLobby(): Lobby {
    return this.createLobby([]);
  }

  sendMessage(message: Message) {
    const messageJSON = showMessage(message);
    const recipients = message.to;

    recipients.forEach(recipientPlayer => {
      const recipientSocket = this.getSocket(recipientPlayer.id);

      if (!recipientSocket) {
        throw new Error(`Could not find socket with id: ${recipientPlayer.id}`);
      }

      recipientSocket.emit('message', messageJSON);
    });
  }
  sendDetails() {
    this.currentContext.players.forEach(player => {
      this.getSocket(player.id).emit('details', playerDetails(player));
    });
  }
}