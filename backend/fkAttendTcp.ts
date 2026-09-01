import net from "node:net";

export type FkPrivilege = 0 | 1;

export interface AttendanceRecord {
  employeeId: number;
  clock: number;
  verifyMode: number;
  timestampRaw: string;
  eventCode: number;
  date: Date | null;
  raw: Buffer;
}
export interface UserEnrollment { privilege: FkPrivilege; pin: boolean; fingerprint: boolean; face: boolean; raw: [number, number, number]; }

export interface DeviceTime {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
  second: number;
}

export class FkAttendTcpClient {
  private socket: net.Socket | null = null;
  private sequence = 0;

  constructor(
    private readonly host: string,
    private readonly port = 5006,
  ) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    this.socket = null;

    this.socket = new net.Socket();
    this.socket.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!;
      const onError = (err: Error) => {
        socket.off("connect", onConnect);
        reject(err);
      };
      const onConnect = () => {
        socket.off("error", onError);
        resolve();
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
      socket.connect(this.port, this.host);
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private nextSequence(): number {
    const value = this.sequence & 0xffff;
    this.sequence = (this.sequence + 1) & 0xffff;
    return value;
  }

  /**
   * 16-byte FK request:
   * 55 AA | dialect | command | 10 command bytes | sequence(u16 LE)
   */
  private buildShort(
    dialect: number,
    command: number,
    args: Buffer = Buffer.alloc(10),
    sequence?: number,
  ): { packet: Buffer; sequence: number } {
    if (args.length !== 10) {
      throw new Error("FK short request args must be exactly 10 bytes");
    }

    const seq = sequence ?? this.nextSequence();
    const packet = Buffer.alloc(16);
    packet[0] = 0x55;
    packet[1] = 0xaa;
    packet[2] = dialect;
    packet[3] = command;
    args.copy(packet, 4);
    packet.writeUInt16LE(seq, 14);

    return { packet, sequence: seq };
  }

  /**
   * Extended request observed on this device:
   * [16-byte request] + 55 AA + content + 00 00
   *
   * For observed commands, bytes 12..13 of the 16-byte request
   * contain content.length (LE).
   */
  private buildExtended(
    dialect: number,
    command: number,
    argsFirst8: Buffer,
    content: Buffer,
  ): { packet: Buffer; sequence: number } {
    if (argsFirst8.length !== 8) {
      throw new Error("argsFirst8 must be exactly 8 bytes");
    }

    const args = Buffer.alloc(10);
    argsFirst8.copy(args, 0);
    args.writeUInt16LE(content.length, 8);

    const { packet: header, sequence } = this.buildShort(
      dialect,
      command,
      args,
    );

    return {
      sequence,
      packet: Buffer.concat([
        header,
        Buffer.from([0x55, 0xaa]),
        content,
        Buffer.from([0x00, 0x00]),
      ]),
    };
  }

  private async send(
    packet: Buffer,
    expectedLength?: number,
    timeoutMs = 3000,
    quietMs = 80,
  ): Promise<Buffer> {
    if (!this.socket) throw new Error("Device is not connected");

    const socket = this.socket;

    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let done = false;
      let quietTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (quietTimer) clearTimeout(quietTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };

      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(Buffer.concat(chunks, total));
      };

      const onError = (err: Error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(err);
      };

      const onClose = () => {
        if (done) return;
        if (total > 0) finish();
        else onError(new Error("Device closed TCP connection"));
      };

      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;

        if (expectedLength && total >= expectedLength) {
          finish();
          return;
        }

        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);

      timeoutTimer = setTimeout(() => {
        onError(new Error(`FK request timeout after ${timeoutMs} ms`));
      }, timeoutMs);

      socket.write(packet);
    });
  }

  private parseAck(response: Buffer, sequence: number): number {
    if (response.length < 10) {
      throw new Error(`Short FK response: ${response.toString("hex")}`);
    }

    if (response[0] !== 0xaa || response[1] !== 0x55) {
      throw new Error(`Invalid FK response header: ${response.toString("hex")}`);
    }

    const responseSequence = response.readUInt16LE(8);
    if (responseSequence !== sequence) {
      throw new Error(
        `FK sequence mismatch. sent=${sequence}, received=${responseSequence}`,
      );
    }

    return response.readUInt32LE(4);
  }

  /**
   * Proven manually against the device.
   * The device may answer with dialect byte 0x02 even when request uses 0x01.
   */
  async ping(): Promise<void> {
    const { packet, sequence } = this.buildShort(0x02, 0x80);
    const response = await this.send(packet, 10);
    this.parseAck(response, sequence);
  }

  /**
   * FK_EnableDevice equivalent.
   * enabled=false before enrollment writes, enabled=true afterwards.
   */
  async setDeviceEnabled(enabled: boolean): Promise<number> {
    const args = Buffer.alloc(10);
    args.writeUInt32LE(enabled ? 1 : 0, 0);
    args.writeUInt16LE(0xffff, 6);

    const { packet, sequence } = this.buildShort(0x02, 0x81, args);
    const response = await this.send(packet, 10);
    return this.parseAck(response, sequence);
  }

  /**
   * FK_PutEnrollData for BACKUP_PSW (10).
   *
   * Content layout derived from the captured 56-byte payload and SDK source:
   *   u32 enrollNumber
   *   u32 backupNumber = 10
   *   u32 privilege
   *   byte enrollData[40] = 0 for password
   *   u32 password
   */
  async putPassword(
    enrollNumber: number,
    password: number,
    privilege: FkPrivilege = 0,
  ): Promise<number> {
    const BACKUP_PSW = 10;

    const content = Buffer.alloc(56);
    content.writeUInt32LE(enrollNumber >>> 0, 0);
    content.writeUInt32LE(BACKUP_PSW, 4);
    content.writeUInt32LE(privilege, 8);
    // In the captured TCP packet the PIN is ASCII inside the 40-byte
    // enrollment buffer, beginning at content offset 24 (1-based byte 25).
    // No PWD_HS1 prefix
    // and no trailing numeric password field are present on this device.
    const passwordTemplate = Buffer.from(String(password), "ascii");
    if (passwordTemplate.length > 27) throw new Error("PIN şablonu 40 byte sınırını aşıyor");
    passwordTemplate.copy(content, 12 + 12);

    const first8 = Buffer.alloc(8);
    first8.writeUInt32LE(BACKUP_PSW, 0);
    first8.writeUInt32LE(privilege, 4);

    const { packet, sequence } = this.buildExtended(
      0x02,
      0x98,
      first8,
      content,
    );

    const response = await this.send(packet, 10);
    return this.parseAck(response, sequence);
  }

  /** Replaces an existing PIN enrollment using the same confirmed 0x98/0x92 flow. */
  async updatePassword(enrollNumber: number, password: number, privilege: FkPrivilege = 0): Promise<void> {
    await this.setDeviceEnabled(false);
    try {
      await this.putPassword(enrollNumber, password, privilege);
      await this.saveEnrollData();
    } finally {
      await this.setDeviceEnabled(true);
    }
  }

  /**
   * FK_SaveEnrollData equivalent.
   * Exact command bytes observed in the SDK capture.
   */
  async saveEnrollData(): Promise<number> {
    const args = Buffer.from([
      0x01, 0x00, 0x00, 0x00,
      0x00, 0x00,
      0xff, 0xff,
      0x00, 0x00,
    ]);

    const { packet, sequence } = this.buildShort(0x02, 0x92, args);
    const response = await this.send(packet, 10);
    return this.parseAck(response, sequence);
  }

  /**
   * FK_SetUserName equivalent.
   * Captured device uses 128-byte UTF-16LE username field.
   */
  async setUserName(enrollNumber: number, name: string): Promise<number> {
    const content = Buffer.alloc(128);

    // Keep one UTF-16 code unit free for NULL termination.
    const encoded = Buffer.from(name.slice(0, 63), "utf16le");
    encoded.copy(content, 0, 0, Math.min(encoded.length, content.length - 2));

    const first8 = Buffer.alloc(8);
    first8.writeUInt32LE(enrollNumber >>> 0, 0);

    const { packet, sequence } = this.buildExtended(
      0x02,
      0xc8,
      first8,
      content,
    );

    const response = await this.send(packet, 10);
    return this.parseAck(response, sequence);
  }

  /** Updates the user privilege using the captured 0x96 + 0x95 sequence. */
  async setUserPrivilege(enrollNumber: number, privilege: FkPrivilege): Promise<void> {
    const privilegeArgs = Buffer.alloc(10);
    privilegeArgs.writeUInt32LE(enrollNumber >>> 0, 0);
    privilegeArgs.writeUInt32LE(privilege, 4);
    privilegeArgs.writeUInt16LE(0xffff, 6);
    const privilegePacket = this.buildShort(0x02, 0x96, privilegeArgs);
    this.parseAck(await this.send(privilegePacket.packet, 10), privilegePacket.sequence);

    const enrollArgs = Buffer.alloc(10);
    enrollArgs.writeUInt32LE(enrollNumber >>> 0, 0);
    enrollArgs.writeUInt16LE(10, 4);
    enrollArgs.writeUInt16LE(0xffff, 6);
    const enrollPacket = this.buildShort(0x02, 0x95, enrollArgs);
    this.parseAck(await this.send(enrollPacket.packet, 10), enrollPacket.sequence);
  }

  /**
   * FK_GetUserName equivalent for the captured 0x02 dialect.
   */
  async getUserName(enrollNumber: number): Promise<string | null> {
    const args = Buffer.alloc(10);
    args.writeUInt32LE(enrollNumber >>> 0, 0);
    args.writeUInt16LE(128, 8);

    const { packet, sequence } = this.buildShort(0x02, 0xc7, args);
    const response = await this.send(packet, 144);
    this.parseAck(response, sequence);

    // Response: AA55...seq | 55AA | 128-byte UTF-16LE name | trailer
    if (
      response.length < 12 ||
      response[10] !== 0x55 ||
      response[11] !== 0xaa
    ) {
      return null;
    }

    const nameBytes = response.subarray(12, Math.min(140, response.length));
    const name = nameBytes
      .toString("utf16le")
      .replace(/\u0000.*$/s, "")
      .trim();

    return name || null;
  }

  /**
   * Creates a password/PIN user without FKAttend.dll.
   *
   * Write order is taken from the captured SDK traffic:
   * disable -> put enroll -> save -> enable -> set username
   */
  async createPasswordUser(
    enrollNumber: number,
    password: number,
    name?: string,
    privilege: FkPrivilege = 0,
  ): Promise<void> {
    await this.setDeviceEnabled(false);

    try {
      await this.putPassword(enrollNumber, password, privilege);
      await this.saveEnrollData();
    } finally {
      await this.setDeviceEnabled(true);
    }

    if (name) {
      await this.setUserName(enrollNumber, name);
    }
  }

  /**
   * Proven by the manual PowerShell test and the R701 implementation.
   * Uses legacy/read dialect byte 0x01.
   */
  async getRecordCount(): Promise<number> {
    const args = Buffer.alloc(10);
    args[0] = 0x08;
    args.writeUInt16LE(0xffff, 6);

    const { packet, sequence } = this.buildShort(0x02, 0xb4, args);
    const response = await this.send(packet, 10);
    this.parseAck(response, sequence);

    return response.readUInt32LE(4);
  }

  /** Reads a documented device-status counter (B4). */
  async getDeviceStatus(index: number): Promise<number> {
    const args = Buffer.alloc(10);
    args.writeUInt32LE(index >>> 0, 0);
    args.writeUInt16LE(0xffff, 6);
    const { packet, sequence } = this.buildShort(0x02, 0xb4, args);
    return this.parseAck(await this.send(packet, 10), sequence);
  }

  /** Reads a documented device-info setting (B0). */
  async getDeviceInfo(index: number): Promise<number> {
    const args = Buffer.alloc(10);
    args.writeUInt32LE(index >>> 0, 0);
    args.writeUInt16LE(0xffff, 6);
    const { packet, sequence } = this.buildShort(0x02, 0xb0, args);
    return this.parseAck(await this.send(packet, 10), sequence);
  }

  async getDeviceVersion(): Promise<number> {
    const args = Buffer.alloc(10);
    args.writeUInt16LE(16, 4);
    args.writeUInt16LE(0xffff, 6);
    const { packet, sequence } = this.buildShort(0x02, 0x79, args);
    return this.parseAck(await this.send(packet, 10), sequence);
  }

  async getDeviceTime(): Promise<DeviceTime> {
    const args = Buffer.alloc(10);
    args.writeUInt16LE(8, 8);
    const { packet, sequence } = this.buildShort(0x02, 0xb2, args);
    const response = await this.send(packet, 24);
    this.parseAck(response, sequence);
    const inner = response.indexOf(Buffer.from([0x55, 0xaa]), 8);
    if (inner < 0 || response.length < inner + 10) throw new Error("Cihaz saat yanıtı çözümlenemedi");
    const value = response.subarray(inner + 2, inner + 10);
    return { year: value.readUInt16LE(0), month: value[2], day: value[3], dayOfWeek: value[4], hour: value[5], minute: value[6], second: value[7] };
  }

  /**
   * FK_SetDeviceTime equivalent, verified in cihaz-saati-degistirme.pcapng.
   * The captured SDK flow is disable (81/0) -> B3 extended time write ->
   * enable (81/1). The eight-byte payload is identical to B2's time value.
   */
  async setDeviceTime(time: Omit<DeviceTime, "dayOfWeek">): Promise<DeviceTime> {
    const { year, month, day, hour, minute, second } = time;
    if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error("Yıl 2000 ile 9999 arasında olmalı");
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("Ay 1 ile 12 arasında olmalı");
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("Gün 1 ile 31 arasında olmalı");
    if (![hour, minute, second].every(value => Number.isInteger(value) && value >= 0 && value <= 59) || hour > 23) {
      throw new Error("Saat, dakika ve saniye geçerli olmalı");
    }

    const date = new Date(year, month - 1, day, hour, minute, second);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error("Geçersiz takvim tarihi");

    const dayOfWeek = date.getDay();
    const content = Buffer.alloc(8);
    content.writeUInt16LE(year, 0);
    content[2] = month;
    content[3] = day;
    content[4] = dayOfWeek;
    content[5] = hour;
    content[6] = minute;
    content[7] = second;

    await this.setDeviceEnabled(false);
    try {
      const request = this.buildExtended(0x02, 0xb3, Buffer.alloc(8), content);
      this.parseAck(await this.send(request.packet, 10), request.sequence);
      return { year, month, day, dayOfWeek, hour, minute, second };
    } finally {
      await this.setDeviceEnabled(true);
    }
  }

  async setDoorStatus(status: 0 | 1 | 2 | 3): Promise<number> {
    const args = Buffer.alloc(10);
    args.writeUInt32LE(status, 0);
    args.writeUInt16LE(0xffff, 6);
    const { packet, sequence } = this.buildShort(0x02, 0xe1, args);
    return this.parseAck(await this.send(packet, 10), sequence);
  }

  /**
   * Reads the device's user-ID directory (command 0x97).
   *
   * The captured SDK flow first reads B4 indexes 1 and 2, then requests
   * count * 10 bytes. Each returned directory entry starts with u32 user ID.
   */
  async getAllUserIds(): Promise<Array<{ enrollNumber: number; enrollment: UserEnrollment }>> {
    // One TCP connection accepts only one active request at a time.
    const managerCount = await this.getDeviceStatus(1);
    const normalUserCount = await this.getDeviceStatus(2);
    const count = managerCount + normalUserCount;
    if (count === 0) return [];

    const byteLength = count * 10;
    if (byteLength > 0xffff) throw new Error("Cihazdaki kullanıcı sayısı listeleme limiti aşıyor");
    const args = Buffer.alloc(10);
    args.writeUInt32LE(byteLength, 0);
    args.writeUInt32LE(count, 4);
    args.writeUInt16LE(byteLength, 8);

    const { packet, sequence } = this.buildShort(0x02, 0x97, args);
    const response = await this.send(packet, 16 + byteLength, 5000);
    this.parseAck(response, sequence);
    const inner = response.indexOf(Buffer.from([0x55, 0xaa]), 8);
    if (inner < 0 || response.length < inner + 2 + byteLength) {
      throw new Error("Kullanıcı dizini yanıtı çözümlenemedi");
    }

    const ids: Array<{ enrollNumber: number; enrollment: UserEnrollment }> = [];
    for (let offset = inner + 2; offset < inner + 2 + byteLength; offset += 10) {
      const id = response.readUInt32LE(offset);
      const marker = response.readUInt16LE(offset + 6);
      const faceMarker = response.readUInt16LE(offset + 8);
      // 97 capture comparison: admin entry has bytes 04..05 = 01 00;
      // normal entry has 00 00. The following two u16 values are the
      // enrollment mask and enabled flag, respectively.
      const privilege = response.readUInt16LE(offset + 4) === 1 ? 1 : 0;
      ids.push({ enrollNumber: id, enrollment: { privilege, pin: marker === 1 || marker === 9, fingerprint: marker === 9, face: faceMarker === 1, raw: [response.readUInt16LE(offset + 4), marker, faceMarker] } });
    }
    return ids.filter(user => user.enrollNumber > 0);
  }

  async getUsers(): Promise<Array<{ enrollNumber: number; name: string | null; privilege: FkPrivilege; enrollment: UserEnrollment }>> {
    const directory = await this.getAllUserIds();
    const users: Array<{ enrollNumber: number; name: string | null; privilege: FkPrivilege; enrollment: UserEnrollment }> = [];
    for (const entry of directory) {
      let name: string | null = null;
      try { name = await this.getUserName(entry.enrollNumber); } catch { /* ID kullanılmaya devam eder. */ }
      users.push({ enrollNumber: entry.enrollNumber, name, privilege: entry.enrollment.privilege, enrollment: entry.enrollment });
    }
    return users;
  }

  /** Deletes only the password/PIN enrollment (BACKUP_PSW = 10). */
  async deletePassword(enrollNumber: number): Promise<number> {
    const args = Buffer.alloc(10);
    args.writeUInt32LE(enrollNumber >>> 0, 0);
    args.writeUInt16LE(10, 4);
    args.writeUInt16LE(0xffff, 6);
    const { packet, sequence } = this.buildShort(0x02, 0x93, args);
    return this.parseAck(await this.send(packet, 10), sequence);
  }

  /** Deletes the fingerprint enrollment captured with BACKUP_FP = 0. */
  async deleteFingerprint(enrollNumber: number): Promise<number> {
    const args = Buffer.alloc(10);
    args.writeUInt32LE(enrollNumber >>> 0, 0);
    args.writeUInt16LE(0, 4);
    args.writeUInt16LE(0xffff, 6);
    const { packet, sequence } = this.buildShort(0x02, 0x93, args);
    return this.parseAck(await this.send(packet, 10), sequence);
  }

  /** Deletes the face enrollment captured with BACKUP_FACE = 30. */
  async deleteFace(enrollNumber: number): Promise<number> {
    const args = Buffer.alloc(10);
    args.writeUInt32LE(enrollNumber >>> 0, 0);
    args.writeUInt16LE(30, 4);
    args.writeUInt16LE(0xffff, 6);
    const { packet, sequence } = this.buildShort(0x02, 0x93, args);
    return this.parseAck(await this.send(packet, 10), sequence);
  }

  /**
   * Uploads a JPEG user photo using the captured F2/F3 flow.
   * F2 declares photo kind=1, user ID and total JPEG bytes; F3 sends
   * consecutive 1024-byte chunks (the last one can be shorter).
   */
  async uploadUserPhoto(enrollNumber: number, jpeg: Buffer): Promise<void> {
    if (jpeg.length === 0) throw new Error("Fotoğraf dosyası boş");
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Cihaz için yalnız JPEG fotoğraf yüklenebilir");

    await this.setDeviceEnabled(false);
    try {
      const metadata = Buffer.alloc(20);
      metadata.writeUInt32LE(1, 0);
      metadata.writeUInt32LE(enrollNumber >>> 0, 4);
      metadata.writeUInt32LE(jpeg.length >>> 0, 12);
      const init = this.buildExtended(0x02, 0xf2, Buffer.alloc(8), metadata);
      this.parseAck(await this.send(init.packet, 10), init.sequence);

      for (let offset = 0, block = 0; offset < jpeg.length; offset += 1024, block += 1) {
        const chunk = jpeg.subarray(offset, Math.min(offset + 1024, jpeg.length));
        const first8 = Buffer.alloc(8);
        first8.writeUInt16LE(block, 6);
        const transfer = this.buildExtended(0x02, 0xf3, first8, chunk);
        this.parseAck(await this.send(transfer.packet, 10, 5000), transfer.sequence);
      }
    } finally {
      await this.setDeviceEnabled(true);
    }
  }

  /** Reads one attendance block, up to 1024 bytes. */
  async getRecordBlock(
    totalRecords: number,
    blockSequence: number,
  ): Promise<Buffer> {
    const args = Buffer.alloc(10);

    if (blockSequence === 0) {
      args.writeUInt16LE(totalRecords & 0xffff, 4);
    } else {
      args.writeUInt16LE(blockSequence & 0xffff, 6);
    }

    const requestedBytes = blockSequence === 0 ? 1024 : Math.min(1024, totalRecords * 20 - blockSequence * 1024);
    args.writeUInt16LE(Math.max(0, requestedBytes), 8);

    const { packet, sequence } = this.buildShort(0x02, 0xa4, args);
    const response = await this.send(packet, undefined, 4000, 100);

    if (response.length < 12 || response[0] !== 0xaa || response[1] !== 0x55) {
      throw new Error(`Malformed record response (${response.length} bytes)`);
    }

    this.parseAck(response, sequence);
    const inner = response.indexOf(Buffer.from([0x55, 0xaa]), 8);
    if (inner < 0 || response.length < inner + 2 + requestedBytes) {
      throw new Error("Devam kaydı bloğu bulunamadı");
    }

    // The A4 payload starts with a four-byte block header (visible as
    // 01 00 00 04 in the captures), followed by 20-byte records.
    const dataStart = inner + 2 + 4;
    if (response.length < dataStart + requestedBytes) {
      throw new Error("Devam kaydı bloğu eksik");
    }
    return response.subarray(dataStart, dataStart + requestedBytes);
  }

  private parseRecord(raw: Buffer, year: number): AttendanceRecord {
    if (raw.length !== 20) throw new Error("Record must be 20 bytes");
    const timestamp0 = raw.readUInt32LE(4);
    const timestamp1 = raw.readUInt32LE(8);
    // The protocol documents this as an additional In/Out state. Its individual
    // bit layout is not yet captured, so keep the original value losslessly.
    const verifyMode = raw.readUInt32LE(12);
    const employeeId = raw.readUInt32LE(16);
    const clock = 0;
    const packed = timestamp0;
    const month = (packed >>> 12) & 0x0f;
    const day = (packed >>> 16) & 0x1f;
    const hour = (packed >>> 21) & 0x1f;
    const minute = (packed >>> 26) & 0x3f;

    return {
      employeeId,
      clock,
      verifyMode,
      timestampRaw: `${timestamp0.toString(16).padStart(8, "0")}${timestamp1.toString(16).padStart(8, "0")}`,
      eventCode: clock,
      date: month >= 1 && month <= 12 && day >= 1 && day <= 31
        ? new Date(year, month - 1, day, hour, minute, 0)
        : null,
      raw: Buffer.from(raw),
    };
  }

  /**
   * Returns 20-byte attendance records captured from the XFace43 protocol.
   */
  async getAttendanceRecords(): Promise<AttendanceRecord[]> {
    const deviceYear = (await this.getDeviceTime()).year;
    if (this.socket?.destroyed) await this.connect();
    const total = await this.getRecordCount();
    if (total === 0) return [];

    const totalBytes = total * 20;
    const blocks = Math.ceil(totalBytes / 1024);
    const data: Buffer[] = [];
    for (let block = 0; block < blocks; block += 1) data.push(await this.getRecordBlock(total, block));
    const input = Buffer.concat(data, totalBytes);
    const records: AttendanceRecord[] = [];
    for (let offset = 0; offset + 20 <= input.length; offset += 20) {
      const record = this.parseRecord(input.subarray(offset, offset + 20), deviceYear);
      if (record.employeeId === 0xffffffff || record.verifyMode === 0xff || record.verifyMode === 0xffffffff) continue;
      records.push(record);
    }
    return records;
  }

  /** Reads all A4 records, then filters locally by the decoded User ID field. */
  async getLogsByUser(userId: number): Promise<AttendanceRecord[]> {
    const records = await this.getAttendanceRecords();
    return records.filter(record => record.employeeId === userId);
  }

}

/*
Example:

const client = new FkAttendTcpClient("192.168.1.215", 5006);

await client.connect();
await client.ping();

await client.createPasswordUser(
  99,       // Enroll Number
  1234,     // Password / PIN
  "TEST99", // User name
  0,        // 0 = normal user
);

console.log(await client.getUserName(99));
console.log(await client.getRecordCount());

client.disconnect();
*/
