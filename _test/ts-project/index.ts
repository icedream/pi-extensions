export interface User {
  id: number;
  name: string;
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export class UserService {
  users: User[] = [];

  add(user: User): void {
    this.users.push(user);
  }
}
