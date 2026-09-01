import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

void main() => runApp(const XFaceApp());

class XFaceApp extends StatelessWidget {
  const XFaceApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(
            seedColor: const Color(0xff23b8ad),
            brightness: Brightness.dark,
          ),
          useMaterial3: true,
        ),
        home: const DeviceScreen(),
      );
}

class DeviceScreen extends StatefulWidget {
  const DeviceScreen({super.key});

  @override
  State<DeviceScreen> createState() => _DeviceScreenState();
}

class _DeviceScreenState extends State<DeviceScreen> {
  final _api = TextEditingController(text: 'http://192.168.1.227:3001');
  final _host = TextEditingController(text: '192.168.1.215');
  final _port = TextEditingController(text: '5006');

  bool _connected = false;
  bool _busy = false;
  int _tab = 0;
  String _message = 'Backend adresini, cihaz IP adresini ve portu girin.';
  List<Map<String, dynamic>> _users = [];
  List<Map<String, dynamic>> _logs = [];
  Map<String, dynamic>? _overview;

  Map<String, dynamic> get _connection => {
        'host': _host.text.trim(),
        'port': int.tryParse(_port.text) ?? 5006,
      };
  ApiClient get _client => ApiClient(_api.text.trim());

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
    } catch (error) {
      _message = error.toString().replaceFirst('Exception: ', '');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _connect() => _run(() async {
        final data = await _client.post('/api/device/test', _connection);
        _connected = true;
        _message = data['message'] ?? 'Cihaza bağlanıldı.';
      });

  Future<void> _readUsers() => _run(() async {
        final data = await _client.get('/api/users', _connection);
        _users = List<Map<String, dynamic>>.from(
          (data['users'] as List).map((value) => Map<String, dynamic>.from(value)),
        );
        _message = '${data['count']} kullanıcı listelendi.';
      });

  Future<void> _readLogs() => _run(() async {
        final data = await _client.get('/api/attendance', _connection);
        _logs = List<Map<String, dynamic>>.from(
          (data['records'] as List).map((value) => Map<String, dynamic>.from(value)),
        );
        _logs.sort((a, b) {
          final left = DateTime.tryParse((a['date'] ?? '').toString())?.millisecondsSinceEpoch ?? 0;
          final right = DateTime.tryParse((b['date'] ?? '').toString())?.millisecondsSinceEpoch ?? 0;
          return right.compareTo(left);
        });
        _message = '${data['count']} log okundu.';
      });

  Future<void> _readOverview() => _run(() async {
        _overview = await _client.get('/api/device/overview', _connection);
        _message = 'Cihaz bilgileri okundu.';
      });

  Future<void> _control(String action) => _run(() async {
        final data = await _client.post('/api/device/control', {..._connection, 'action': action});
        _message = data['message'] ?? 'Komut gönderildi.';
      });

  Future<void> _addUser() async {
    final id = TextEditingController();
    final name = TextEditingController();
    final pin = TextEditingController();
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('PIN kullanıcısı ekle'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: id, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Kullanıcı ID')),
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Ad soyad')),
          TextField(controller: pin, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'PIN')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('İptal')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Ekle')),
        ],
      ),
    );
    if (accepted != true) return;
    final userId = int.tryParse(id.text);
    final password = int.tryParse(pin.text);
    if (userId == null || password == null || name.text.trim().isEmpty) {
      setState(() => _message = 'ID, ad soyad ve PIN zorunludur.');
      return;
    }
    await _run(() async {
      final data = await _client.post('/api/users', {
        ..._connection,
        'enrollNumber': userId,
        'name': name.text.trim(),
        'password': password,
        'privilege': 0,
      });
      _message = data['message'] ?? 'PIN kullanıcısı eklendi.';
      await _readUsers();
    });
  }

  Future<void> _updateTime() async {
    final value = TextEditingController();
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Cihaz saatini güncelle'),
        content: TextField(
          controller: value,
          decoration: const InputDecoration(
            labelText: 'Tarih ve saat',
            hintText: '2026-09-01T14:30',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('İptal')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Güncelle')),
        ],
      ),
    );
    if (accepted != true) return;
    final date = DateTime.tryParse(value.text.trim());
    if (date == null) {
      setState(() => _message = 'Geçerli tarih/saat girin.');
      return;
    }
    await _run(() async {
      final data = await _client.post('/api/device/time', {
        ..._connection,
        'year': date.year, 'month': date.month, 'day': date.day,
        'hour': date.hour, 'minute': date.minute, 'second': date.second,
      });
      _message = data['message'] ?? 'Cihaz saati güncellendi.';
      _overview = await _client.get('/api/device/overview', _connection);
    });
  }

  Future<void> _deleteEnrollment(int userId, String method) async {
    await _run(() async {
      final data = await _client.delete('/api/users/$userId/$method', _connection);
      _message = data['message'] ?? 'Kayıt silindi.';
      final usersData = await _client.get('/api/users', _connection);
      _users = List<Map<String, dynamic>>.from(
        (usersData['users'] as List).map((value) => Map<String, dynamic>.from(value)),
      );
    });
  }

  Future<void> _updatePin(int userId) async {
    final controller = TextEditingController();
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('#$userId PIN güncelle'),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Yeni PIN'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('İptal')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Güncelle')),
        ],
      ),
    );
    if (accepted != true) return;
    final pin = int.tryParse(controller.text);
    if (pin == null || pin < 1) {
      setState(() => _message = 'Geçerli PIN girin.');
      return;
    }
    await _run(() async {
      final data = await _client.patch('/api/users/$userId/password', {
        ..._connection,
        'password': pin,
      });
      _message = data['message'] ?? 'PIN güncellendi.';
    });
  }

  void _showUser(Map<String, dynamic> user) {
    final enrollment = Map<String, dynamic>.from(user['enrollment'] ?? {});
    final userId = user['enrollNumber'] as int;
    showModalBottomSheet(
      context: context,
      builder: (context) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('#${user['enrollNumber']} · ${user['name'] ?? 'Ad okunamadı'}', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          _enrollmentRow('PIN', enrollment['pin'] == true, onUpdate: () { Navigator.pop(context); _updatePin(userId); }, onDelete: () { Navigator.pop(context); _deleteEnrollment(userId, 'password'); }),
          _enrollmentRow('Parmak izi', enrollment['fingerprint'] == true, onDelete: () { Navigator.pop(context); _deleteEnrollment(userId, 'fingerprint'); }),
          _enrollmentRow('Yüz', enrollment['face'] == true, onDelete: () { Navigator.pop(context); _deleteEnrollment(userId, 'face'); }),
          const ListTile(contentPadding: EdgeInsets.zero, title: Text('Kart'), subtitle: Text('Silme paketi doğrulanmadı')),
        ]),
      ),
    );
  }

  Widget _enrollmentRow(String label, bool exists, {VoidCallback? onUpdate, VoidCallback? onDelete}) => ListTile(
    contentPadding: EdgeInsets.zero,
    title: Text(label),
    subtitle: Text(exists ? 'Tanımlı' : 'Yok'),
    trailing: exists ? Wrap(children: [
      if (onUpdate != null) IconButton(onPressed: _busy ? null : onUpdate, icon: const Icon(Icons.edit)),
      if (onDelete != null) IconButton(onPressed: _busy ? null : onDelete, icon: const Icon(Icons.delete, color: Colors.redAccent)),
    ]) : null,
  );

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('XFace43 Mobil')),
    body: ListView(padding: const EdgeInsets.all(16), children: [
      _connectionCard(),
      Card(child: Padding(padding: const EdgeInsets.all(12), child: Text(_message))),
      if (_connected) _module(),
    ]),
    bottomNavigationBar: _connected ? NavigationBar(
      selectedIndex: _tab,
      onDestinationSelected: (value) => setState(() => _tab = value),
      destinations: const [
        NavigationDestination(icon: Icon(Icons.people), label: 'Kullanıcılar'),
        NavigationDestination(icon: Icon(Icons.list), label: 'Raporlar'),
        NavigationDestination(icon: Icon(Icons.door_front_door), label: 'Kapı'),
        NavigationDestination(icon: Icon(Icons.settings), label: 'Sistem'),
      ],
    ) : null,
  );

  Widget _connectionCard() => Card(child: Padding(
    padding: const EdgeInsets.all(14),
    child: _connected
      ? Row(children: [const Icon(Icons.check_circle, color: Colors.green), const SizedBox(width: 8), const Expanded(child: Text('Cihaza bağlı')), OutlinedButton(onPressed: _busy ? null : () => setState(() => _connected = false), child: const Text('Bağlantıyı kes'))])
      : Column(children: [
          TextField(controller: _api, decoration: const InputDecoration(labelText: 'Backend API adresi')),
          Row(children: [Expanded(child: TextField(controller: _host, decoration: const InputDecoration(labelText: 'Cihaz IP adresi'))), const SizedBox(width: 8), SizedBox(width: 90, child: TextField(controller: _port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'TCP port')))]),
          const SizedBox(height: 10),
          SizedBox(width: double.infinity, child: FilledButton(onPressed: _busy ? null : _connect, child: const Text('Bağlan'))),
        ]),
  ));

  Widget _module() {
    if (_tab == 0) return Column(children: [
      Row(children: [Expanded(child: FilledButton.tonal(onPressed: _busy ? null : _addUser, child: const Text('PIN kullanıcısı ekle'))), const SizedBox(width: 8), Expanded(child: FilledButton.tonal(onPressed: _busy ? null : _readUsers, child: const Text('Kullanıcıları oku')))]),
      ..._users.map((user) => ListTile(onTap: () => _showUser(user), title: Text('#${user['enrollNumber']} · ${user['name'] ?? 'Ad okunamadı'}'), subtitle: Text('PIN: ${user['enrollment']?['pin'] == true ? 'Var' : 'Yok'} · Parmak izi: ${user['enrollment']?['fingerprint'] == true ? 'Var' : 'Yok'} · Yüz: ${user['enrollment']?['face'] == true ? 'Var' : 'Yok'}'), trailing: const Icon(Icons.chevron_right))),
    ]);
    if (_tab == 1) return Column(children: [
      FilledButton.tonal(onPressed: _busy ? null : _readLogs, child: const Text('Tüm logları oku')),
      ..._logs.take(50).map((log) => ListTile(title: Text('Kullanıcı #${log['employeeId']}'), subtitle: Text('${log['date'] ?? ''} · ${_verifyName(log['verifyMode'])}'))),
    ]);
    if (_tab == 2) return Wrap(spacing: 8, runSpacing: 8, children: [_controlButton('Kapıyı aç', 'door-open'), _controlButton('Kapıyı kapat', 'door-close'), _controlButton('Otomatik kapanma', 'door-auto')]);
    return Column(children: [
      _controlButton('Cihazı etkinleştir', 'enable'),
      _controlButton('Cihazı devre dışı bırak', 'disable'),
      FilledButton.tonal(onPressed: _busy ? null : _readOverview, child: const Text('Cihaz saatini oku')),
      FilledButton.tonal(onPressed: _busy ? null : _updateTime, child: const Text('Cihaz saatini güncelle')),
      if (_overview != null) Text('Cihaz saati: ${_overview!['time']}'),
    ]);
  }

  Widget _controlButton(String label, String action) => FilledButton.tonal(onPressed: _busy ? null : () => _control(action), child: Text(label));
  String _verifyName(dynamic code) => {1: 'Parmak izi', 2: 'PIN / Şifre', 20: 'Yüz', 21: 'VFace'}[code] ?? 'Bilinmeyen';
}

class ApiClient {
  ApiClient(this.baseUrl);
  final String baseUrl;
  Uri _uri(String path, [Map<String, dynamic>? query]) => Uri.parse(baseUrl + path).replace(queryParameters: query?.map((key, value) => MapEntry(key, value.toString())));
  Future<Map<String, dynamic>> get(String path, Map<String, dynamic> query) => _request('GET', _uri(path, query));
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) => _request('POST', _uri(path), body);
  Future<Map<String, dynamic>> patch(String path, Map<String, dynamic> body) => _request('PATCH', _uri(path), body);
  Future<Map<String, dynamic>> delete(String path, Map<String, dynamic> body) => _request('DELETE', _uri(path), body);
  Future<Map<String, dynamic>> _request(String method, Uri uri, [Map<String, dynamic>? body]) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, uri);
      request.headers.contentType = ContentType.json;
      if (body != null) request.write(jsonEncode(body));
      final response = await request.close();
      final text = await utf8.decoder.bind(response).join();
      final data = text.isEmpty ? <String, dynamic>{} : Map<String, dynamic>.from(jsonDecode(text));
      if (response.statusCode < 200 || response.statusCode >= 300) throw Exception(data['message'] ?? 'API hatası (${response.statusCode})');
      return data;
    } finally { client.close(force: true); }
  }
}
