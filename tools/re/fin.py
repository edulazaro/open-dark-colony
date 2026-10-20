import struct,sys
def cstr(b): return b.split(b'\0')[0].decode('latin1')
def load_fin(path):
    d=open(path,'rb').read()
    ver,nfr,nan,nj=struct.unpack_from('<4H',d,0); p=8
    juice=[cstr(d[p+i*8:p+i*8+8]) for i in range(nj)]; p+=nj*8
    anims=[]
    for i in range(nan):
        anims.append((cstr(d[p:p+16]),)+struct.unpack_from('<hh',d,p+16)); p+=20
    frames=[]
    for i in range(nfr):
        np_,delay=struct.unpack_from('<hh',d,p); ev=[]
        for k in range(8):
            q=p+4+k*20; ev.append((cstr(d[q:q+16]),)+struct.unpack_from('<hh',d,q+16))
        frames.append([np_,delay,ev,[]]); p+=164
    for f in frames:
        for k in range(f[0]):
            f[3].append((cstr(d[p:p+8]),)+struct.unpack_from('<7h',d,p+8)); p+=22
    return dict(ver=ver,juice=juice,anims=anims,frames=frames,end=p,size=len(d))
if __name__=='__main__':
    f=load_fin(sys.argv[1])
    print('ver',f['ver'],'juice',f['juice'],'end',f['end'],'size',f['size'],'anims',len(f['anims']),'frames',len(f['frames']))
    for a in f['anims'][:int(sys.argv[2]) if len(sys.argv)>2 else 200]:
        print(a, [ (fr[1], fr[3], [e for e in fr[2] if e[0]!='NONAME']) for fr in f['frames'][a[1]:a[2]+1]][:3])
